# Use with Svelte 5

Goal: collect and apply types for `<script lang="ts">` blocks in `.svelte`
files. `@ts-capture/svelte` instruments those blocks and writes inferred types
back into the correct `<script>` block. It pairs with `@ts-capture/vite`, which
supplies the runtime collector for the Vite/Vitest pipeline.

```svelte title="Input"
<script lang="ts">
  function format(value) {
    return value.toFixed(2);
  }
</script>
```

```svelte title="Expected"
<script lang="ts">
  function format(value: number): string {
    return value.toFixed(2);
  }
</script>
```

## Install

```sh
npm install --save-dev @ts-capture/svelte@next @ts-capture/vite@next @ts-capture/core@next
```

Peer dependencies: `@ts-capture/core` and `svelte >=5.0.0`.

## Register the preprocessor and plugin

```ts title="vite.config.ts"
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tsCapture from "@ts-capture/vite";
import { sveltePreprocessor } from "@ts-capture/svelte";

export default defineConfig({
  plugins: [svelte({ preprocess: [sveltePreprocessor()] }), tsCapture()],
});
```

## Collect, merge, apply

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run   # preview
npx ts-capture apply types.json
```

`apply` edits your source — run it from a committed working tree
([Review & apply safely](review-and-apply-safely.md)).

## Route apply back to `.svelte` files

`.svelte` files reach the CLI as synthetic virtual paths
(`<file>.svelte__script.ts` / `<file>.svelte__module.ts`). Register
`sveltePlugin()` so the CLI routes those entries back to the owning `.svelte`
file via the offset-aware applier — without it, the core CLI warns and skips
every synthetic svelte path.

```js title="ts-capture.config.mjs"
import { sveltePlugin } from "@ts-capture/svelte";

export default { plugins: [sveltePlugin()] };
```

## `$state` runes inside effects — `attachPeek`

A Svelte 5 `$state` proxy can register reactive subscriptions when read inside
an `$effect`. If observation may happen in an effect context, wrap the state so
ts-capture walks the unwrapped value via Svelte's `snapshot()`:

```ts
import { attachPeek } from "@ts-capture/svelte/runes";

let profile = attachPeek($state({ name: "alice", age: 30 }));
```

`$state({...})` read **outside** an effect is walked correctly without this
helper — use `attachPeek` only when reads happen inside an effect.

## Next

- [Review & apply safely](review-and-apply-safely.md) before applying on a real
  codebase.
- [Configuration reference](../reference/configuration.md).
