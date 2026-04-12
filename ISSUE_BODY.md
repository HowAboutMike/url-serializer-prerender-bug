# Bug report

## Affected Package

The issue is caused by package `@angular/ssr`, with related behavior in `@angular/router`.

## Is this a regression?

Unknown — I have not tested earlier versions. Reproduced fresh on Angular 21.2.7.

## Description

When you provide a custom `UrlSerializer` that rewrites URLs (e.g. to add a locale prefix transparently), `ng build` with `RenderMode.Prerender` silently writes **meta-refresh redirect HTML stubs** to disk instead of rendered component HTML — for every prerendered route. The build reports `✓ Prerendered N static routes` with no warning.

The override works correctly in dev mode (`ng serve`) and at runtime in the browser. The console shows `parse()` and `serialize()` firing on every navigation, the address bar updates correctly, and hard-loading a transformed URL successfully strips the prefix and matches the route. So `UrlSerializer` DI is honored — the failure is specific to the prerender disk-write step.

I traced the cause to (what appears to be) a round-trip check in the prerender pipeline:

```ts
const tree = urlSerializer.parse(routePath);
const canonical = urlSerializer.serialize(tree);
if (canonical !== routePath) {
  // emit a meta-refresh redirect HTML page instead of the rendered component
}
```

This logic is correct for declarative `{ path: 'old', redirectTo: 'new' }` routes — `dist/.../old/index.html` should redirect crawlers to `/new`. But it conflates "Router-level redirect" with "UrlSerializer-level URL rewriting", and there is no way to opt out for a rewriting serializer. Every route in the table trips the redirect branch.

The user-visible result: the build appears to succeed, but every prerendered HTML file is a 10-line meta-refresh stub. Crawlers and runtime fetchers see no rendered content. The browser does a meta-refresh to a URL that has no prerendered file, falls through to runtime SSR, which (in the default scaffold) returns the empty `index.csr.html` shell. Effective result: SSR is silently disabled, no warning, no error.

## Please provide a link to a minimal reproduction of the bug

https://github.com/<your-username>/url-serializer-prerender-bug

The repo is ~80 LOC on top of a standard `ng new` + `ng add @angular/ssr` scaffold. README has a one-command repro and the expected vs actual disk output.

Quick repro after cloning:

```bash
npm install
npm run build
cat dist/url-serializer-spike/browser/about/index.html
```

Expected: rendered `<app-about>` component HTML.
Actual: 10-line `<meta http-equiv="refresh" content="0; url=/en/about">` stub.

## Please provide the exception or error you saw

No exception. No build error. No warning. The build output is:

```
✔ Building...
...
Prerendered 2 static routes.
Application bundle generation complete.
```

The failure is silent and only visible by inspecting the prerendered HTML files on disk.

## Please provide the environment you discovered this bug in (run `ng version`)

```
Angular CLI: 21.2.7
Node: 24.13.0
Package Manager: npm 11.6.2
OS: win32 x64

Angular: 21.2.0
... animations, common, compiler, compiler-cli, core, forms,
    platform-browser, platform-browser-dynamic, platform-server,
    router, ssr

Package                          Version
----------------------------------------
@angular-devkit/architect        0.2102.7
@angular-devkit/build-angular    21.2.7
@angular-devkit/core             21.2.7
@angular-devkit/schematics       21.2.7
@angular/build                   21.2.7
@angular/cli                     21.2.7
@angular/ssr                     21.2.7
@schematics/angular              21.2.7
rxjs                             7.8.x
typescript                       5.9.x
```

(Same Angular versions, same behavior expected on Linux/macOS — the failure is in the build pipeline, not platform-specific.)

## Anything else relevant?

**Workaround for the i18n use case:**
Move the URL transformation from `UrlSerializer` to the route table itself — e.g. wrap public routes in a parent `{ path: ':locale', children: [...] }`. This works because route paths and serialized URLs agree (both contain the locale segment), so the round-trip check passes for every route. This is the approach the Angular ecosystem already uses (it's what `@angular/localize` runtime guides recommend), but it requires rewriting every `routerLink="/foo"` to add the locale prefix, plus a directive or helper to avoid hard-coding the active locale at every call site. A `UrlSerializer` override would have been the more idiomatic, lower-touch path — if it worked.

**Suggested fixes** (in order of effort):

1. **Doc note** — add a sentence to the [`RenderMode.Prerender`](https://angular.dev/api/ssr/RenderMode#Prerender) and [`UrlSerializer`](https://angular.dev/api/router/UrlSerializer) reference pages stating that overriding `UrlSerializer` is incompatible with `Prerender` for any rewriting transform.
2. **Build-time warning** — emit a warning when a non-`DefaultUrlSerializer` provider is used together with `RenderMode.Prerender`.
3. **Distinguish redirect from rewrite** — gate the meta-refresh emit on whether the `UrlTree` was actually produced by a Router-level `redirectTo` resolution, not on a round-trip equality check against the route table path. This would unlock a real use case (transparent URL rewriting with SSR + prerender) and resolve the underlying conflation.

Even (1) alone would prevent silent failures. (3) would close the gap properly.
