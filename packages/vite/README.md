# @ts-capture/vite

Vite plugin for [ts-capture](../core) — automatic TypeScript type annotation
via runtime observation. Works for both **Vitest** (Node-side) and
**browser dev sessions** (Vite dev server).

## Why a Vite plugin?

The ts-capture evaluation found that **most modern OSS TypeScript projects
use Vitest** (~60 % of a 17-project survey). The Vite plugin
pattern reaches that segment directly. Source on disk is never
modified — instrumentation happens entirely in Vite's transform
pipeline — so projects that lint, format-check, or typecheck before
running tests stay green.

## Install

```sh
npm install --save-dev @ts-capture/vite @ts-capture/core
```

## Use with Vitest

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import tsCapture from "@ts-capture/vite";

export default defineConfig({
  plugins: [tsCapture()],
});
```

Run tests:

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
```

After tests, observations land in `${TS_CAPTURE_TYPES_DIR}/ts-capture-types-<uuid>.json`
(one file per worker / fork). Merge them and apply via the ts-capture CLI:

```sh
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run   # preview
npx ts-capture apply types.json             # edits your source files
```

`apply` edits your source — run it from a committed working tree
([Review & apply safely](../../docs/how-to/review-and-apply-safely.md)).

See `examples/vitest/` for a complete working example.

> **Note:** the `outputFile` option does **not** apply here — it only
> takes effect in `vite serve` (dev-server / browser) mode. Use the
> `TS_CAPTURE_TYPES_DIR` + `ts-capture merge` flow for Vitest and
> `vite build`. The plugin logs a warning if `outputFile` is set in a
> non-serve mode.

## Use in a Vite dev server (browser)

Same plugin registration in `vite.config.ts`. The plugin auto-detects
the browser environment and reports observations to a
`/__ts-capture_collect` endpoint that the plugin itself serves: with
`fetch` soon after they are made and every 10 seconds, and with
`navigator.sendBeacon` when the page unloads. Optional `apply: true`
writes types back to source on each report; `outputFile: 'types.json'`
dumps them to disk:

```ts
plugins: [tsCapture({ apply: true, outputFile: '.ts-capture-types.json' })],
```

> **`apply: true` rewrites your source files while you browse**, with no
> preview step and underneath your open editor. Only enable it on a committed
> working tree.

### What the dev server exposes

In `vite serve` the plugin mounts a middleware at `/__ts-capture_collect` and
accepts `POST`ed observation payloads there. It is unauthenticated, like the
rest of the dev server — fine on localhost, but don't expose a ts-capture dev
server on a shared network, and don't enable the plugin in a production build.

The `transports` option (and the `TS_CAPTURE_TRANSPORT_URL` env var) replaces
that default by **sending browser observations to a URL you configure** — an
outbound data flow describing the shapes your app handled, and with
`infer.literal.*` enabled the
[observed values themselves](../../docs/how-to/review-and-apply-safely.md#observed-values-in-your-output).
Point it only at a collector you control.

## Options

```ts
plugins: [
  tsCapture({
    enabled: process.env.CI !== "true", // off: nothing instrumented, no dumps written
    exclude: /node_modules|\.spec\.ts$/, // skip files matching this regex
    apply: true, // vite serve only: auto-apply on each browser report
    outputFile: ".ts-capture-types.json", // vite serve only: dump the reported observations to JSON
    literalOptions: { literalString: true, literalStringMaxLength: 24 }, // observe literals
  }),
];
```

`literalOptions` turns on literal observation (`literalString`,
`literalStringMaxLength`, `literalNumber`, `literalBoolean`) for the run; unset
fields fall back to the `TS_CAPTURE_LITERAL_*` env vars. The matching
`infer.literal.*` must be on for `apply` too, or the observed literals widen
back — see the
[configuration reference](../../docs/reference/configuration.md#literal--preserve-literal-types-instead-of-widening).

With the plugin in the config, every test run instruments and writes dumps.
`enabled: false` switches it off in place, and so does `TS_CAPTURE_ENABLED=false`
in the environment of the run, for the times the config should stay as it is:

```sh
TS_CAPTURE_ENABLED=false npm test
```

`apply` and `outputFile` are honored only in `vite serve` (dev-server /
browser) mode. Under Vitest or `vite build`, see the
[Vitest section](#use-with-vitest) for the `TS_CAPTURE_TYPES_DIR` +
`ts-capture merge` flow.

## How the runtime works

`tsCapturePlugin().transform()` runs on every `.ts/.tsx/.mts/.cts` file Vite
processes:

1. Calls `instrumentSource(code, id, { skipTscptrDeclarations: true })` (from `@ts-capture/core`).
2. Prepends a universal `__tscptr__` collector snippet to every file
   (Symbol-keyed init guard makes repeat execution a cheap no-op —
   needed because Vitest can load files in any worker order).
3. The collector branches on environment:
   - **Browser**: `fetch` to `/__ts-capture_collect` on the next tick
     after an observation and every 10 seconds; `navigator.sendBeacon` on
     `beforeunload`.
   - **Node**: per-PID JSON dump under `TS_CAPTURE_TYPES_DIR` with periodic
     500 ms flush + standard exit handlers + eager flush every 10
     observations (Vitest workers don't reliably reach
     `process.on("exit")`).

## Validated against

End-to-end validation:

| Project                        | Test runner                                     | Outcome                                                   |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------------- |
| `examples/vitest/` (synthetic) | vitest                                          | ✅ all 3 functions correctly typed                        |
| `defu`                         | vitest (npm test = lint && typecheck && vitest) | ✅ 59 obs, 3 files, all tests pass                        |
| `ofetch`                       | vitest                                          | ✅ 117 obs, 6 files, all tests pass                       |
| `h3`                           | vitest                                          | ✅ 2553 obs, 90 files, baseline-equivalent test pass-rate |
| `hono`                         | vitest with multi-runtime workspace             | ⚠️ partial — Bun/Deno test envs fail to load              |

`defu`, `ofetch`, and `h3` were all blocked by the older
runtime-shim approach because their
`npm test` runs lint or format-check first against on-disk source —
which the shim modifies. The Vite-plugin path's in-memory transform
keeps them unblocked.

## License

MIT.
