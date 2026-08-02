# Use with Vite / Vitest

Goal: collect types from a Vitest suite (or a Vite dev session) without
modifying source on disk. This guide assumes you already know the
[observe → merge → apply](../explanation/how-it-works.md) flow.

## Install

```sh
npm install --save-dev @ts-capture/vite@next @ts-capture/core@next
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
TS_CAPTURE_TYPES_DIR=/tmp/ts-capture npm test
npx ts-capture merge /tmp/ts-capture --out types.json
npx ts-capture apply types.json --dry-run   # preview
npx ts-capture apply types.json
```

`apply` edits your source — run it from a committed working tree
([Review & apply safely](review-and-apply-safely.md)).

Observations land in `${TS_CAPTURE_TYPES_DIR}/ts-capture-types-<uuid>.json`,
one file per worker/fork — that's why a `merge` step is needed before `apply`.

## Options

```ts
plugins: [
  tsCapture({
    exclude: /node_modules|\.spec\.ts$/, // skip files matching this regex
    apply: true, // vite serve only: auto-apply on each browser beacon
    outputFile: ".ts-capture-types.json", // vite serve only: dump beacon payload
  }),
];
```

`apply` and `outputFile` are honored **only** in `vite serve` (dev-server /
browser) mode. Under Vitest or `vite build`, use the `TS_CAPTURE_TYPES_DIR` +
`ts-capture merge` flow above. The plugin warns if `outputFile` is set outside
serve mode.

## Browser dev sessions

The same plugin registration works in a Vite dev server. The plugin
auto-detects the browser environment and reports observations via
`navigator.sendBeacon` to a `/__ts-capture_collect` endpoint it serves. Set
`apply: true` to write types back on each beacon, or
`outputFile: 'types.json'` to dump them to disk.

## Next

- [Review & apply safely](review-and-apply-safely.md) before running on an
  existing codebase.
- [Configuration reference](../reference/configuration.md) for inference tuning.
