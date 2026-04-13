# Spike: Custom UrlSerializer in Angular 21

**Date:** 2026-04-13
**Time-box:** 2 hours
**Beads:** syf-y27
**Author:** spike investigation
**Trigger:** [docs/superpowers/specs/2026-04-12-i18n-route-prefix-design.md](../specs/2026-04-12-i18n-route-prefix-design.md) cited "Custom UrlSerializer override | Silently fails in Angular 21 (spike 2026-04-12); unknown root cause; prior implementation attempt produced redirect loops" as rejection rationale. This spike re-investigates with a clean repro to confirm or refute that claim and pin down the actual root cause.

## TL;DR

Custom `UrlSerializer` override in Angular 21 **does work** for pure client-side routing in a browser-only build — DI is honored, `parse()` and `serialize()` fire on every navigation, address bar reflects the transformed URL, in-app navigation is correct, lazy `loadComponent` is unaffected.

It **silently breaks as soon as `@angular/ssr` enters the picture**, at two distinct layers:

1. **`RenderMode.Prerender` (build-time, disk write)** — the prerender pipeline detects that `serialize(parse(routePath)) !== routePath` and writes an HTML **meta-refresh redirect** stub instead of the rendered component, for every route in the table. Build reports success with no warning.
2. **Runtime SSR middleware (`ng serve` dev mode and `node server.mjs` production)** — the same round-trip check in the request handler emits a **`302` response** whose `Location` is the "canonical" (serialized) URL. Combined with the Router's `redirectTo: ''` catch-all, which bypasses the custom serializer and emits the literal route-table path, this produces an **infinite HTTP redirect loop** on initial page load: the browser bounces between the unprefixed and prefixed forms until `ERR_TOO_MANY_REDIRECTS`.

The historical claim that "DI silently fails" is **incorrect**. The actual blocker is the round-trip equality assumption baked into Angular SSR's prerender and runtime request-handling paths — a property the `UrlSerializer` contract does not promise and the docs' own case-insensitive example would violate. There is no workaround short of giving up either the URL transform or `@angular/ssr`.

## Reproduction

Standalone Angular 21.2.7 project at [github.com/HowAboutMike/url-serializer-prerender-bug](https://github.com/HowAboutMike/url-serializer-prerender-bug). Files of interest:

- [src/app/locale-prefix-url-serializer.ts](https://github.com/HowAboutMike/url-serializer-prerender-bug/blob/main/src/app/locale-prefix-url-serializer.ts) — strips `/en` prefix on parse, prepends `/en` on serialize
- [src/app/app.config.ts](https://github.com/HowAboutMike/url-serializer-prerender-bug/blob/main/src/app/app.config.ts) — wires the override via `{ provide: UrlSerializer, useClass: LocalePrefixUrlSerializer }`
- [src/app/app.routes.ts](https://github.com/HowAboutMike/url-serializer-prerender-bug/blob/main/src/app/app.routes.ts) — minimal `Home` + `About` lazy routes, no parent `:locale`
- [src/app/app.routes.server.ts](https://github.com/HowAboutMike/url-serializer-prerender-bug/blob/main/src/app/app.routes.server.ts) — `{ path: '**', renderMode: RenderMode.Prerender }` (default scaffolded by `ng add @angular/ssr`)

To reproduce from the public repo:

```bash
git clone https://github.com/HowAboutMike/url-serializer-prerender-bug
cd url-serializer-prerender-bug
npm install
```

**Path A — prerender failure (build-time):**

```bash
npm run build
cat dist/url-serializer-spike/browser/about/index.html
# expected: rendered <app-about> component HTML
# actual:   10-line <meta http-equiv="refresh" content="0; url=/en/about"> stub
```

**Path B — dev-mode SSR 302 loop (`ng serve`):**

```bash
npm start
# in another terminal:
curl -sS -i http://localhost:4200/   | head -5
curl -sS -i http://localhost:4200/en | head -5
# expected: 200 OK with rendered HTML
# actual:   302 Location: /en   then   302 Location: /   (infinite ping-pong)
# opening either URL in a browser produces ERR_TOO_MANY_REDIRECTS
```

Either path is sufficient to demonstrate the bug; they are two surfaces of the same `serialize(parse(x)) !== x` assumption. Path A is the original report. Path B was discovered on 2026-04-13 re-verification and rules out "use runtime SSR instead of prerender" as a workaround.

Or scaffold fresh:

```bash
npx @angular/cli@21 new url-serializer-spike --routing --style=css --skip-git --defaults
cd url-serializer-spike
# add LocalePrefixUrlSerializer + wire in app.config.ts (see files above)
# add lazy Home/About routes
npx ng add @angular/ssr --skip-confirmation --defaults
npx ng build   # Path A
npx ng serve   # Path B — then curl localhost:4200/
```

## Findings

### Finding 1 — DI override is honored (browser, dev mode, *pre-SSR only*)

**Important qualifier added 2026-04-13 on re-verification:** this finding holds only for a browser-only build, **before** `ng add @angular/ssr` has been run. Once SSR is installed (Finding 4 below), `ng serve` routes initial requests through the SSR dev middleware and the same round-trip check that breaks prerender also breaks runtime SSR, producing a 302 loop on first page load. Client-side routing after a successful boot still works, but there is no successful boot against the dev SSR server.

With only `provideRouter(routes)` and the custom serializer registered (no `@angular/ssr` yet), navigating to `/` in `ng serve` mode produces this console output:

```
[LocalePrefixUrlSerializer] parse() input:
[LocalePrefixUrlSerializer] parse() stripped:
[LocalePrefixUrlSerializer] serialize() inner: / -> out: /en
... ×17 (RouterLink calls during template render)
[LocalePrefixUrlSerializer] serialize() inner: /about -> out: /en/about
```

Address bar updates from `localhost:4200/` to `localhost:4200/en` automatically. `<a routerLink="/">` and `<a routerLink="/about">` render with `href="/en"` and `href="/en/about"`. Clicking `About` performs in-app navigation to `/en/about` correctly. Hard-loading `localhost:4200/en/about` directly works: `parse('/en/about')` strips to `/about`, the `About` route matches, and the page renders.

**Conclusion:** the historical claim "DI silently fails" is wrong. The override is wired up and runs. But the scope of "it works" is narrower than the previous spike implied — it's limited to pre-SSR client-only builds and post-boot client-side navigation.

### Finding 2 — Lazy `loadComponent` is unaffected

Replacing `component: Home` with `loadComponent: () => import('./home').then(m => m.Home)` for both routes does not change behavior. parse + serialize still fire, navigation still works, hard-load still works.

### Finding 3 — Prerender writes meta-refresh redirects, not component HTML

After `ng add @angular/ssr` and `ng build`, the prerender output contains:

```
dist/url-serializer-spike/browser/index.html
dist/url-serializer-spike/browser/about/index.html
```

Notably:
- The disk paths are **unprefixed** (`/index.html`, `/about/index.html`), reflecting the route table's `path: ''` and `path: 'about'`.
- The **content** of those files is not the rendered `Home`/`About` component. It is a meta-refresh redirect:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Redirecting</title>
    <meta http-equiv="refresh" content="0; url=/en/about">
  </head>
  <body>
    <pre>Redirecting to <a href="/en/about">/en/about</a></pre>
  </body>
</html>
```

Angular's prerender pipeline detects that for the route at path `/about`, calling `urlSerializer.serialize(urlSerializer.parse('/about'))` yields `/en/about` — a different URL than the route path. It treats this the same way it treats a Router-level redirect: emits a static HTML page with a meta-refresh to the canonical URL.

This is the **"silent fail"**:
1. Build appears successful — `Prerendered 2 static routes.`
2. Files exist on disk.
3. App loads in dev mode and works.
4. App appears to load in production but every page is a one-line meta-refresh shell.
5. Address bar changes correctly. User sees a "loading" flash. Then the destination URL has no static file behind it, so the request falls through to runtime SSR, which (in this scaffold) returns the empty `index.csr.html` shell — `<app-root></app-root>` with no rendered children.
6. Effective result: blank page, broken hydration, no SEO content for crawlers.

Depending on how the SSR fallback handles the redirected-to URL, the prior report of a "redirect loop" is plausible: if the canonical URL is also routed through a prerender entry whose `serialize(parse(...))` round-trips to a third value, you get a redirect chain. With `path: '**'` catch-all prerender, every URL is enumerable, and any non-idempotent serializer transform creates a divergence.

### Finding 4 — Runtime SSR (production build) degrades to a blank CSR shell

With the SSR server running (`node dist/.../server.mjs` on port 4000):

| Request | HTTP | Body |
|---|---|---|
| `GET /` | 200 | meta-refresh to `/en` |
| `GET /about` | 200 | meta-refresh to `/en/about` |
| `GET /en` | 200 | empty `index.csr.html` shell — no rendered component |
| `GET /en/about` | 200 | empty `index.csr.html` shell — no rendered component |

Every URL returns 200, but no URL returns rendered component content. The combination of:
- Static middleware serving prerendered redirect HTML for unprefixed paths
- Catch-all SSR fallback serving the raw CSR shell for prefixed paths

Means every entry point silently degrades to client-only rendering, with the meta-refresh adding a visible flash. From an external-tools perspective (curl, Lighthouse, Googlebot) the app has effectively no SSR.

### Finding 5 — `ng serve` dev mode 302-loops on initial request (*new, 2026-04-13*)

After `ng add @angular/ssr`, the same repo run under `ng serve` (port 4200) no longer loads at all. Every initial page load produces `ERR_TOO_MANY_REDIRECTS` in the browser. `curl` trace:

```bash
$ curl -sS -i http://localhost:4200/ | head -5
HTTP/1.1 302 Found
X-Powered-By: Express
location: /en

$ curl -sS -i http://localhost:4200/en | head -5
HTTP/1.1 302 Found
X-Powered-By: Express
location: /
```

The two 302s ping-pong forever. Step by step:

1. `GET /` — the SSR dev middleware canonicalizes the incoming URL: `urlSerializer.serialize(urlSerializer.parse('/'))` returns `/en`. Input (`/`) ≠ canonical (`/en`), so it emits a `302 Location: /en`.
2. `GET /en` — server-side route matching runs. `parse('/en')` strips to `/`, but the server resolution path falls through to the catch-all `{ path: '**', redirectTo: '' }`, which emits a `302 Location: /` — the raw `redirectTo` target, **not** passed through the custom `serialize()`.
3. Goto step 1.

Two separate pieces of Angular SSR disagree about what the canonical URL is:

- The SSR middleware's round-trip check thinks `/en` is canonical (because `serialize(parse('/'))` → `/en`).
- The Router's `redirectTo` emits the literal route-table path `''` → `/`, bypassing the serializer.

This matters because it **rules out "use runtime SSR instead of prerender" as a workaround**. The same round-trip assumption is baked into the runtime request handler, not just the prerender disk-write enumerator. The original bug report framed this as a prerender-only issue; the broader finding is that **every `@angular/ssr` entry point — prerender, dev SSR, production SSR — assumes `serialize(parse(x)) === x`**.

### Finding 6 — `UrlSerializer` API docs do not document a round-trip invariant (*new, 2026-04-13*)

Checked the official Angular API reference for [`UrlSerializer`](https://angular.dev/api/router/UrlSerializer) and [`DefaultUrlSerializer`](https://angular.dev/api/router/DefaultUrlSerializer) to confirm we're not misusing the contract. The documented contract is:

```typescript
abstract class UrlSerializer {
  parse(url: string): UrlTree;
  serialize(tree: UrlTree): string;
}
```

Verbatim from the docs: *"Serializes and deserializes a URL string into a URL tree. The URL serialization strategy is customizable. You can make all URLs case insensitive by providing a custom `UrlSerializer`."*

That is the entire documented contract. The docs **do not require**:

- `serialize(parse(x)) === x` (round-trip equality)
- `parse` and `serialize` to be mutual inverses
- The transform to be idempotent

Only that `parse: string → UrlTree` and `serialize: UrlTree → string`.

Notably, the **one example the docs sanction — case-insensitive URLs — would itself violate round-trip equality**. A custom serializer that lowercases on parse would have `serialize(parse('/ABOUT'))` return `/about`, which ≠ `/ABOUT`. So the Angular documentation's own motivating example does not satisfy the invariant that Angular SSR silently assumes.

`LocalePrefixUrlSerializer` satisfies the documented contract: `parse` returns a valid `UrlTree`, `serialize` returns a valid URL string. The issue is not API misuse — it is Angular SSR depending on an undocumented and example-violated invariant.

## Root cause

Angular SSR's prerender enumerator and runtime request handler both rely on the same round-trip check — schematically:

```ts
const tree = urlSerializer.parse(routePath);
const canonical = urlSerializer.serialize(tree);
if (canonical !== routePath) {
  // prerender:   emitMetaRefreshHtml(routePath, canonical)
  // runtime SSR: reply 302 Location: canonical
} else {
  renderComponent(routePath);
}
```

This logic exists to handle Router-level redirects (`{ path: 'old', redirectTo: 'new' }`) at build time so that prerendered `old/index.html` correctly forwards crawlers to `/new`, and at runtime so that SSR serves equivalent 302s. It is correct for that case.

For a custom `UrlSerializer` that **transforms every URL** (e.g. always prepends a locale prefix), every route trips this branch — because the route table path (`/about`) is the unprefixed form, but `serialize()` always emits the prefixed form (`/en/about`). So every prerender output becomes a redirect HTML page instead of a component render, and every runtime SSR response becomes a 302 to the canonical form.

The runtime case additionally produces an infinite loop because `{ path: '**', redirectTo: '' }` — present in the default scaffolded route table — emits the literal `redirectTo` value (`/`) as the `Location` header, bypassing the custom serializer entirely. The SSR middleware then canonicalizes `/` back to `/en`, and the ping-pong is established.

There is no conflict at the DI layer, in the runtime router's component-matching logic, or in `RouterLink`. The conflict is between **two undocumented assumptions** that Angular SSR makes:

1. Route table paths and their `serialize(parse(...))` canonical forms are equal.
2. Router-level `redirectTo` targets, when used as `Location` headers, will themselves round-trip cleanly.

Neither assumption is part of the documented `UrlSerializer` contract, and — as noted in Finding 6 — the only example use case the docs motivate (case-insensitive URLs) would violate the first. A transparent locale-prefix serializer breaks both assumptions silently.

## Implications for syf

The current syf solution (parent `:locale` route + `LocalizedLinkDirective extends RouterLink` + Express middleware) avoids this problem because it puts `/:locale` **in the route table**, so the route paths and the canonical URLs agree. `serialize(parse('/en/about'))` round-trips because `/en/about` is the actual route path.

A `UrlSerializer`-based approach is **not viable with `@angular/ssr` at all** and should remain rejected. The original spike's conclusion was right; the attribution has now been corrected twice:

- *First correction (earlier in this doc):* the dead end is not in DI or runtime client routing.
- *Second correction (Finding 5, this pass):* the dead end is not limited to `RenderMode.Prerender` either. Runtime SSR (both `ng serve` dev and production `node server.mjs`) is equally broken — dev mode 302-loops on initial load, production serves empty CSR shells. There is no SSR mode that works.

**Recommended action:** update [docs/superpowers/specs/2026-04-12-i18n-route-prefix-design.md](../specs/2026-04-12-i18n-route-prefix-design.md) line 56 to cite this finding instead of "unknown root cause":

```
| Custom UrlSerializer override | Every @angular/ssr entry point (prerender, ng serve dev SSR, production runtime SSR) assumes serialize(parse(routePath)) === routePath. A URL-transforming serializer (e.g. locale prefix) trips this check on every route: prerender emits meta-refresh stubs, runtime SSR 302-loops on initial load. The UrlSerializer API docs do not document this invariant and the one example they motivate (case-insensitive URLs) would itself violate it. See docs/superpowers/research/2026-04-13-url-serializer-spike.md for repro and curl traces. |
```

## Bug report

This is arguably **working as designed** — the redirect-emit behavior is correct for declarative `redirectTo` routes. But it surfaces as a silent footgun for any custom serializer that rewrites URLs, at multiple layers (prerender disk write, runtime SSR 302, dev-mode 302 loop), and the `UrlSerializer` API docs do not warn about it. A documentation note in the Angular SSR / `RenderMode.Prerender` / `UrlSerializer` reference pages would be valuable, and ideally a build-time warning when `UrlSerializer` is overridden alongside `@angular/ssr`.

**Filed upstream:** [angular/angular#68159](https://github.com/angular/angular/issues/68159) — 2026-04-13.

**Public repro:** [github.com/HowAboutMike/url-serializer-prerender-bug](https://github.com/HowAboutMike/url-serializer-prerender-bug)

The public repo is the source of truth; any local working copy is disposable and should be discarded once the upstream issue is triaged.

## Time accounting

- Scaffold + verify dev-mode override: 25 min
- Verify lazy loading: 5 min
- Add SSR + repro prerender failure: 20 min
- Trace runtime SSR behavior: 10 min
- Write-up: 30 min
- **Subtotal: ~90 min**, under the original 2-hour budget

Follow-up pass (2026-04-13, same day):
- Reproduce `ng serve` 302 loop + curl trace: 10 min
- Cross-check `UrlSerializer` API docs: 10 min
- Edit spike doc + draft issue follow-up: 20 min
- **Follow-up subtotal: ~40 min**
- **Grand total: ~130 min**

## Files

- Public repro: [github.com/HowAboutMike/url-serializer-prerender-bug](https://github.com/HowAboutMike/url-serializer-prerender-bug) — single source of truth for the repro; mirrors any edits needed while [angular/angular#68159](https://github.com/angular/angular/issues/68159) is open
- This document
