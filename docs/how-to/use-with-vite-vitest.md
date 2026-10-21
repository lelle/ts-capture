# Use with Vite / Vitest

Goal: collect types from a Vitest suite (or a Vite dev session) without
modifying source on disk. This guide assumes you already know the
[observe → merge → apply](../explanation/how-it-works.md) flow.

## Install

```sh
npm install --save-dev @ts-capture/vite @ts-capture/core
```

## Register the plugin

```ts title="vitest.config.ts"
import { defineConfig } from "vitest/config";
import tsCapture from "@ts-capture/vite";

export default defineConfig({
  plugins: [tsCapture()],
});
```

Instrumentation happens in Vite's transform pipeline, so projects that lint,
format-check, or type-check on-disk source before running tests stay green.

## Collect, merge, apply

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run   # preview
npx ts-capture apply types.json
```

Commit first; `apply` edits your source ([review & apply safely](review-and-apply-safely.md)).

Observations land in `${TS_CAPTURE_TYPES_DIR}/ts-capture-types-<uuid>.json`,
one file per worker/fork — that's why a `merge` step is needed before `apply`.

## Switch it off for a run

With the plugin in the config, every test run instruments and writes dumps.
`TS_CAPTURE_ENABLED=false` switches it off for one run; the `enabled` option
does it in the config. Every option is in the
[`@ts-capture/vite` README](../../packages/vite/README.md#options).

```sh
TS_CAPTURE_ENABLED=false npm test
```

## Browser dev sessions

The same plugin registration works in a Vite dev server. In the browser,
observations are sent to an endpoint the dev server serves; `apply: true`
writes types back on each report, `outputFile: 'types.json'` dumps them to
disk. Both work only in `vite serve`.

```ts
plugins: [tsCapture({ apply: true, outputFile: ".ts-capture-types.json" })],
```

> **`apply: true` rewrites your source files while you browse**, with no
> preview step and underneath your open editor. Only enable it on a committed
> working tree.

Before you use it on a shared network, read
[what the dev server exposes](../../packages/vite/README.md#what-the-dev-server-exposes).

## Next

[Review & apply safely](review-and-apply-safely.md) ·
[Configuration](../reference/configuration.md)
