# @ts-capture/vite

Vite plugin for [ts-capture](../core) — collects the types your code is called
with, in **Vitest** (Node-side) and in **browser dev sessions** (Vite dev
server).

Instrumentation happens in Vite's transform pipeline, so source on disk is
never modified and projects that lint, format-check or type-check before their
tests stay green.

```sh
npm install --save-dev @ts-capture/vite @ts-capture/core
```

```ts title="vitest.config.ts"
import { defineConfig } from "vitest/config";
import tsCapture from "@ts-capture/vite";

export default defineConfig({
  plugins: [tsCapture()],
});
```

**Full guide:** [Use with Vite / Vitest](../../docs/how-to/use-with-vite-vitest.md)
— running the tests, merging, applying, and browser dev sessions. A complete
example is in `examples/vitest/`.

## What the dev server exposes

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

`enabled: false` switches the plugin off in the config;
`TS_CAPTURE_ENABLED=false` does it for one run.

`apply` and `outputFile` are honored only in `vite serve` (dev-server /
browser) mode, and the plugin warns if `outputFile` is set outside it. Under
Vitest or `vite build`, observations go to `TS_CAPTURE_TYPES_DIR` and are merged
with `ts-capture merge` — see the [guide](../../docs/how-to/use-with-vite-vitest.md).

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
