# Spike: Custom UrlSerializer in Angular 21

**Date:** 2026-04-13
**Time-box:** 2 hours
**Beads:** syf-y27
**Author:** spike investigation
**Trigger:** [docs/superpowers/specs/2026-04-12-i18n-route-prefix-design.md](../specs/2026-04-12-i18n-route-prefix-design.md) cited "Custom UrlSerializer override | Silently fails in Angular 21 (spike 2026-04-12); unknown root cause; prior implementation attempt produced redirect loops" as rejection rationale. This spike re-investigates with a clean repro to confirm or refute that claim and pin down the actual root cause.

## TL;DR

Custom `UrlSerializer` override in Angular 21 **does work** for client-side routing (DI is honored, `parse()` and `serialize()` fire on every navigation, browser address bar reflects the transformed URL, hard-loads succeed, lazy `loadComponent` is unaffected).

It **silently breaks** under SSR with `RenderMode.Prerender` for any non-trivial transform: Angular's prerender pipeline detects that `serialize(parse(routePath)) !== routePath` and **emits an HTML meta-refresh redirect** instead of the rendered component. This is the "silent fail / redirect loop" the original spike report described — the failure mode is not in DI or runtime routing, it is in the prerender disk-write step.

The historical claim that "DI silently fails" is **incorrect**. The actual blocker is the prerender redirect-emit behavior, which is structural and not bypassable without giving up either prerendering or the URL transform.

## Reproduction

Standalone Angular 21.2.7 project at `c:/Users/istih/tmp/url-serializer-spike/`. Files of interest:

- [src/app/locale-prefix-url-serializer.ts](file:///c:/Users/istih/tmp/url-serializer-spike/src/app/locale-prefix-url-serializer.ts) — strips `/en` prefix on parse, prepends `/en` on serialize
- [src/app/app.config.ts](file:///c:/Users/istih/tmp/url-serializer-spike/src/app/app.config.ts) — wires the override via `{ provide: UrlSerializer, useClass: LocalePrefixUrlSerializer }`
- [src/app/app.routes.ts](file:///c:/Users/istih/tmp/url-serializer-spike/src/app/app.routes.ts) — minimal `Home` + `About` lazy routes, no parent `:locale`
- [src/app/app.routes.server.ts](file:///c:/Users/istih/tmp/url-serializer-spike/src/app/app.routes.server.ts) — `{ path: '**', renderMode: RenderMode.Prerender }` (default scaffolded by `ng add @angular/ssr`)

To reproduce from scratch:

```powershell
cd c:/Users/istih/tmp
npx @angular/cli@21 new url-serializer-spike --routing --style=css --skip-git --defaults
cd url-serializer-spike
# add LocalePrefixUrlSerializer + wire in app.config.ts (see files above)
# add lazy Home/About routes
npx ng add @angular/ssr --skip-confirmation --defaults
npx ng build
```

## Findings

### Finding 1 — DI override is honored (browser, dev mode)

With only `provideRouter(routes)` and the custom serializer registered, navigating to `/` in `ng serve` mode produces this console output:

```
[LocalePrefixUrlSerializer] parse() input:
[LocalePrefixUrlSerializer] parse() stripped:
[LocalePrefixUrlSerializer] serialize() inner: / -> out: /en
... ×17 (RouterLink calls during template render)
[LocalePrefixUrlSerializer] serialize() inner: /about -> out: /en/about
```

Address bar updates from `localhost:4321/` to `localhost:4321/en` automatically. `<a routerLink="/">` and `<a routerLink="/about">` render with `href="/en"` and `href="/en/about"`. Clicking `About` performs in-app navigation to `/en/about` correctly. Hard-loading `localhost:4321/en/about` directly works: `parse('/en/about')` strips to `/about`, the `About` route matches, and the page renders.

**Conclusion:** the historical claim "DI silently fails" is wrong. The override is wired up and runs.

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

### Finding 4 — Runtime SSR is also broken under this scaffold

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

## Root cause

In Angular SSR's `RenderMode.Prerender`, when enumerating routes to write to disk, the build pipeline computes for each candidate routePath:

```ts
const tree = urlSerializer.parse(routePath);
const canonical = urlSerializer.serialize(tree);
if (canonical !== routePath) {
  emitMetaRefreshHtml(routePath, canonical);
} else {
  emitRenderedHtml(routePath);
}
```

This logic exists to handle Router-level redirects (`{ path: 'old', redirectTo: 'new' }`) at build time so that prerendered `old/index.html` correctly forwards crawlers to `/new`. It is correct for that case.

For a custom `UrlSerializer` that **transforms every URL** (e.g. always prepends a locale prefix), every route trips this branch — because the route table path (`/about`) is the unprefixed form, but `serialize()` always emits the prefixed form (`/en/about`). So every prerender output becomes a redirect HTML page instead of a component render.

There is no conflict at the DI layer, in the runtime router, or in `RouterLink`. The conflict is between **two contracts**: the route table's paths and the URL serializer's canonical form. Angular SSR assumes those agree. A transparent locale-prefix serializer breaks that assumption silently.

## Implications for syf

The current syf solution (parent `:locale` route + `LocalizedLinkDirective extends RouterLink` + Express middleware) avoids this problem because it puts `/:locale` **in the route table**, so the route paths and the canonical URLs agree. `serialize(parse('/en/about'))` round-trips because `/en/about` is the actual route path.

A `UrlSerializer`-based approach is **not viable** for prerendering and should remain rejected. The current spec's wording ("avoids the UrlSerializer override dead end") is correct in conclusion but incorrect in attribution — the dead end is in `RenderMode.Prerender`, not in DI or runtime routing.

**Recommended action:** update [docs/superpowers/specs/2026-04-12-i18n-route-prefix-design.md](../specs/2026-04-12-i18n-route-prefix-design.md) line 56 to cite this finding instead of "unknown root cause":

```
| Custom UrlSerializer override | Angular SSR RenderMode.Prerender emits a meta-refresh redirect HTML page for any route where serialize(parse(routePath)) !== routePath. A locale-prefix serializer trips this for every route, producing blank pages and effective loss of SSR. See docs/superpowers/research/2026-04-13-url-serializer-spike.md for repro and trace. |
```

## Bug report

This is arguably **working as designed** — the redirect-emit behavior is correct for declarative redirects. But it surfaces as a silent footgun for any custom serializer that rewrites URLs. A documentation note in the Angular SSR / `RenderMode.Prerender` reference would be valuable, and possibly a build-time warning when `UrlSerializer` is overridden alongside Prerender.

**Filed upstream:** [angular/angular#68159](https://github.com/angular/angular/issues/68159) — 2026-04-13.

**Public repro:** [github.com/HowAboutMike/url-serializer-prerender-bug](https://github.com/HowAboutMike/url-serializer-prerender-bug)

Local copy of the repro: `c:/Users/istih/tmp/url-serializer-spike/` — kept while issue is open in case upstream asks for changes; remove after triage.

## Time accounting

- Scaffold + verify dev-mode override: 25 min
- Verify lazy loading: 5 min
- Add SSR + repro prerender failure: 20 min
- Trace runtime SSR behavior: 10 min
- Write-up: 30 min
- **Total: ~90 min**, under the 2-hour budget

## Files

- Public repro: [github.com/HowAboutMike/url-serializer-prerender-bug](https://github.com/HowAboutMike/url-serializer-prerender-bug)
- Local repro: `c:/Users/istih/tmp/url-serializer-spike/` — keep while [angular/angular#68159](https://github.com/angular/angular/issues/68159) is open
- This document
