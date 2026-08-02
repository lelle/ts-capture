# @ts-capture/svelte

Svelte 5 preprocessor for [ts-capture](../core) — automatic TypeScript
type annotation via runtime observation. Instruments `<script lang="ts">`
blocks in `.svelte` files so ts-capture can fill in implicit `any` from
observed runtime values, then writes the inferred types back into the
right `<script>` block.

## Why a Svelte preprocessor?

`.svelte` files aren't plain TypeScript — their `<script>` blocks live
inside component markup at file-relative byte offsets that no `.ts`-only
tool tracks. This package plugs into the Svelte preprocess chain to
instrument those blocks, and ships an offset-aware applier
(`applySvelteTypesToFile` / `sveltePlugin()`) that remaps each block's
collected type-info from block-relative back to file-relative positions
before writing annotations into the owning `.svelte` file.

It pairs with [`@ts-capture/vite`](../vite), which supplies the runtime
`__tscptr__` collector for the Vite / Vitest pipeline.

## Install

```sh
npm install --save-dev @ts-capture/svelte@next @ts-capture/vite@next @ts-capture/core@next
```

Peer dependencies: `@ts-capture/core` and `svelte >=5.0.0`.

## Transformation

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

## Use with Vitest

Register `sveltePreprocessor()` in the Svelte plugin's `preprocess`
chain, and add the `@ts-capture/vite` plugin so the runtime collector is
installed across the Vitest run:

```ts
// vite.config.ts
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tsCapture from "@ts-capture/vite";
import { sveltePreprocessor } from "@ts-capture/svelte";

export default defineConfig({
  plugins: [svelte({ preprocess: [sveltePreprocessor()] }), tsCapture()],
});
```

Run tests, then merge and apply the collected types:

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run   # preview
npx ts-capture apply types.json             # edits your source files
```

`apply` edits your source — run it from a committed working tree
([Review & apply safely](../../docs/how-to/review-and-apply-safely.md)).

## Apply types back to `.svelte` files

`.svelte` files reach the CLI as synthetic virtual paths
(`<file>.svelte__script.ts` / `<file>.svelte__module.ts`). Register
`sveltePlugin()` so the CLI routes those entries back to the owning
`.svelte` file via the offset-aware applier. Without it, the core CLI
prints a stderr warning and skips every synthetic svelte path.

```js title="ts-capture.config.mjs"
import { sveltePlugin } from "@ts-capture/svelte";

export default { plugins: [sveltePlugin()] };
```

For programmatic use, call the applier directly (from
`@ts-capture/svelte/apply`):

```ts
import { applySvelteTypesToFile } from "@ts-capture/svelte/apply";

const annotated = applySvelteTypesToFile(source, collectedTypes, {
  svelteFilename: "src/lib/Counter.svelte",
});
```

`ApplySvelteTypesOptions` extends core's `ApplyTypesOptions` with the
required `svelteFilename` — the resolved `.svelte` path used to match
each entry's virtual prefix back to the correct `<script>` block.

## `$state` runes — `attachPeek`

ts-capture observes runtime values by walking them. A Svelte 5 `$state`
proxy can register reactive subscriptions when read inside an `$effect`.
`attachPeek` (from `@ts-capture/svelte/runes`) attaches the ts-capture
peek protocol so the walker observes the unwrapped plain value via
Svelte's `snapshot()` instead of the reactive proxy:

```ts
import { attachPeek } from "@ts-capture/svelte/runes";

let profile = attachPeek($state({ name: "alice", age: 30 }));
```

`$state({...})` read **outside** an effect is already walked correctly
without this helper — property reads on a Svelte proxy outside an
`$effect` don't register subscriptions. Use `attachPeek` only when
observation may happen inside an effect context.

> **Note:** `attachPeek` uses `svelte/internal/client.snapshot`, an
> internal (non-public) Svelte runtime API. If Svelte exposes `snapshot`
> publicly in a future version, this implementation can be replaced.

## How it works

1. `sveltePreprocessor()` returns a Svelte preprocessor whose `script`
   hook runs on every `<script>` block. Blocks without `lang="ts"`
   (plain JS, including SvelteKit's generated `root.svelte`) are passed
   through unchanged — instrumenting them would inject TS-only `declare`
   statements into JS source and break the compile step.
2. For TS blocks it calls `instrumentSource(...)` (from
   `@ts-capture/core`) against a virtual filename
   (`<file>.svelte__script.ts` or `<file>.svelte__module.ts`) so the
   block can later be routed back to the right offset.
3. Svelte 5 reserves the `$` prefix for runes ($state, $derived, $props,
   …) and requires them as the direct right-hand side of a declaration
   or class field. The preprocessor skips wrapping any `$`-prefixed
initializer call so rune placement stays valid, while still honoring
a caller-supplied `skipInitializerCalleeWhen` for non-rune sites.
4. After the run, `sveltePlugin()` / `applySvelteTypesToFile` remaps the
   collected block-relative offsets back to file-relative positions and
   writes annotations into the owning `.svelte` file's `<script>`
   blocks.

`SveltePreprocessorOptions` extends core's `InstrumentOptions`, so any
core instrument option is accepted by `sveltePreprocessor(options)`.

## License

MIT.
