# Repro: `RenderMode.Prerender` silently emits meta-refresh stubs when a custom `UrlSerializer` rewrites URLs

Minimal reproduction for an Angular SSR issue.

## TL;DR

When you provide a custom `UrlSerializer` that rewrites URLs (e.g. to add a locale prefix transparently), `ng build` with `RenderMode.Prerender` silently writes **meta-refresh redirect HTML stubs** to disk instead of rendered component HTML — for every prerendered route. The build reports "✅ Prerendered N routes" with no warning.

The override works correctly in dev mode (`ng serve`) and at runtime in the browser. Only the prerender disk-write step is broken.

## Versions

- `@angular/core`: 21.2.0
- `@angular/router`: 21.2.0
- `@angular/ssr`: 21.2.7
- `@angular/cli`: 21.2.7
- Node: 24.13.0
- Platform: Windows 11 (also reproducible on Linux/macOS — failure is in the build pipeline, not platform-specific)

## How to reproduce

```bash
git clone https://github.com/<your-username>/url-serializer-prerender-bug.git
cd url-serializer-prerender-bug
npm install
npm run build
cat dist/url-serializer-spike/browser/about/index.html
```

**Expected** — `about/index.html` contains the rendered `<app-about>` component with `<h1>About</h1>` and `<nav>` links.

**Actual** — `about/index.html` is a 10-line meta-refresh stub:

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

The same applies to `dist/url-serializer-spike/browser/index.html` — meta-refresh to `/en` instead of the rendered `<app-home>`.

## Verifying that the override itself works (dev mode)

```bash
npm start
# open http://localhost:4200/ in a browser
# open devtools console
```

Expected console output (proves DI is honored and `parse`/`serialize` fire on every navigation):

```
[LocalePrefixUrlSerializer] parse() input:
[LocalePrefixUrlSerializer] parse() stripped:
[LocalePrefixUrlSerializer] serialize() inner: / -> out: /en
[LocalePrefixUrlSerializer] serialize() inner: /about -> out: /en/about
...
```

The address bar updates from `/` to `/en` automatically. Hard-loading `http://localhost:4200/en/about` works: `parse('/en/about')` strips to `/about`, the route matches, the page renders.

So the failure is **specific to the prerender disk-write step**, not to DI, runtime routing, or `RouterLink`.

## What I think is happening

In `RenderMode.Prerender`, the build pipeline appears to compute, for each route:

```ts
const tree = urlSerializer.parse(routePath);
const canonical = urlSerializer.serialize(tree);
if (canonical !== routePath) {
  emitMetaRefreshHtml(routePath, canonical); // <-- always taken when serializer rewrites
} else {
  emitRenderedHtml(routePath);
}
```

This logic is correct for declarative `{ path: 'old', redirectTo: 'new' }` routes — `dist/.../old/index.html` should redirect crawlers to `/new`. But it conflates "Router-level redirect" with "UrlSerializer-level URL rewriting", and there is no way to opt out without removing the serializer override.

For a serializer that prepends a locale prefix to every URL, every route trips the redirect branch, so every prerendered file becomes a meta-refresh stub.

## Suggested fixes (in order of effort)

1. **Doc note** — add a sentence to the [`RenderMode.Prerender`](https://angular.dev/api/ssr/RenderMode#Prerender) and [`UrlSerializer`](https://angular.dev/api/router/UrlSerializer) reference pages stating that overriding `UrlSerializer` is incompatible with `Prerender` for any rewriting transform.
2. **Build-time warning** — emit a warning when `provideRouter()` is used together with a non-`DefaultUrlSerializer` provider AND `RenderMode.Prerender`.
3. **Distinguish redirect from rewrite** — gate the meta-refresh emit on whether the `UrlTree` was actually produced by a `redirectTo` resolution, not on a round-trip equality check against the route table path.

(1) is enough to prevent the silent footgun. (2) would help users discover the constraint without reading docs. (3) would unlock a real use case (transparent URL rewriting + SSR + prerender).

## File map

- [`src/app/locale-prefix-url-serializer.ts`](src/app/locale-prefix-url-serializer.ts) — the failing serializer (strips `/en` on parse, prepends `/en` on serialize)
- [`src/app/logging-url-serializer.ts`](src/app/logging-url-serializer.ts) — passive serializer that just logs (works fine, kept for comparison)
- [`src/app/app.config.ts`](src/app/app.config.ts) — wires the override via `{ provide: UrlSerializer, useClass: LocalePrefixUrlSerializer }`
- [`src/app/app.routes.ts`](src/app/app.routes.ts) — minimal `Home` + `About` routes, no parent `:locale`, no SSR-specific config
- [`src/app/app.routes.server.ts`](src/app/app.routes.server.ts) — default `{ path: '**', renderMode: RenderMode.Prerender }` from `ng add @angular/ssr`

Total: ~80 LOC of project-specific code on top of the standard Angular CLI scaffold.

## License

MIT — see [LICENSE](LICENSE).
