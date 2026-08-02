# @ts-capture/esbuild

esbuild plugin for [ts-capture](../core) — automatic TypeScript type
annotation via runtime observation.

Targets the esbuild plugin API directly. Works with **tsup**, **direct
esbuild builds**, and any tool that accepts esbuild plugins.

## Why an esbuild plugin?

`@ts-capture/vite` covers Vite + Vitest. `@ts-capture/babel-plugin` covers
Babel-based stacks (Jest, Vite-with-Babel). Stacks built on esbuild —
tsup, direct `esbuild` CLI, `tsx`, Bun bundler — had no first-class
adapter and required `ts-capture instrument --in-place` as a pre-build
step. This plugin closes that gap.

## Install

```sh
npm install --save-dev @ts-capture/esbuild@next @ts-capture/core@next
```

## Use with tsup

```ts
// tsup.config.ts
import { defineConfig } from "tsup";
import { tsCaptureEsbuildPlugin } from "@ts-capture/esbuild";

export default defineConfig({
  entry: ["src/index.ts"],
  esbuildPlugins: [tsCaptureEsbuildPlugin()],
});
```

Then bundle, run with the runtime preloaded, and apply the collected
types back to source. The final step edits your source — run it from a
committed working tree
([Review & apply safely](../../docs/how-to/review-and-apply-safely.md)):

```sh
tsup
NODE_OPTIONS='--require @ts-capture/core/preload' TS_CAPTURE_TYPES_DIR=./.ts-capture \
  node dist/index.js     # or whatever exercises the bundle
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json
```

## Use with esbuild directly

```ts
import * as esbuild from "esbuild";
import { tsCaptureEsbuildPlugin } from "@ts-capture/esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  plugins: [tsCaptureEsbuildPlugin()],
});
```

## Options

```ts
tsCaptureEsbuildPlugin({
  // Regex to whitelist files for instrumentation. Combine with
  // `exclude` to subtract. Defaults to `.ts/.tsx/.mts/.cts`.
  include: /src\//,

  // Regex to exclude files (e.g. tests, node_modules).
  exclude: /node_modules|\.spec\.ts$/,

  // Auto-inject `require("@ts-capture/core/preload")` at the top of each
  // entry file. Saves you the `NODE_OPTIONS='--require ...'` setup,
  // but the bundle's output `format` must be CJS — a CJS require
  // call breaks under ESM output. Default: false.
  injectRuntime: false,
});
```

## Runtime setup

ts-capture observes runtime values, so something has to run the bundled
output with `globalThis.__tscptr__` defined. Two paths:

### NODE_OPTIONS preload (default, works for both CJS and ESM outputs)

```sh
NODE_OPTIONS='--require @ts-capture/core/preload' node dist/bundle.js
```

### `injectRuntime: true` (CJS bundles only)

```ts
tsCaptureEsbuildPlugin({ injectRuntime: true });
```

The plugin prepends a `require("@ts-capture/core/preload")` at the top of each
entry file (entries identified via `build.initialOptions.entryPoints`).
Bundled non-entry modules are not touched — Node's module cache makes
a repeated require a no-op, so duplication would just inflate the
bundle without functional gain.

## Limitations

- **Source maps point at instrumented positions, not the original
  source.** `instrumentSource()` shifts character offsets to splice
  in `__tscptr__(...)` calls; esbuild's downstream sourcemap is computed
  against the post-instrument text. Stack traces still point at the
  right files but the columns may be off by the inserted instrumentation
  width. Matches `@ts-capture/vite`'s tradeoff. A precise position remap
  is on the future-work pile.
- **No Bun-bundler-specific code yet.** Bun accepts esbuild-shaped
  plugins so this package should work under `Bun.build()`, but it's
  not yet exercised in the eval matrix.
- **No watch-mode-specific handling.** Plugin is stateless per build
  invocation; rebuilds re-read source files and re-instrument from
  scratch.

## License

MIT.
