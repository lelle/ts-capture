# @ts-capture/svelte

Svelte 5 preprocessor for [ts-capture](../core) — collects the types your
`<script>` blocks are called with. Instruments `<script lang="ts">` blocks in
`.svelte` files so ts-capture can fill in implicit `any` from observed runtime
values, then writes the observed types back into the right `<script>` block.

Plain TypeScript tools cannot place a type inside a `<script>` block, so this
package instruments the blocks through the Svelte preprocess chain and remaps
each observation from block-relative back to file-relative offsets when it
applies. It pairs with [`@ts-capture/vite`](../vite), which supplies the runtime
collector.

```sh
npm install --save-dev @ts-capture/svelte @ts-capture/vite @ts-capture/core
```

Peer dependencies: `@ts-capture/core` and `svelte >=5.0.0`.

```ts title="vite.config.ts"
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tsCapture from "@ts-capture/vite";
import { sveltePreprocessor } from "@ts-capture/svelte";

export default defineConfig({
  plugins: [svelte({ preprocess: [sveltePreprocessor()] }), tsCapture()],
});
```

**Full guide:** [Use with Svelte 5](../../docs/how-to/use-with-svelte.md) —
collecting, applying back into `.svelte` files with `sveltePlugin()`, and
`$state` runes inside effects.

## Programmatic apply

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
`annotateSvelte` takes the same arguments and also returns the positions it
did not write, with the reason for each.

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

`attachPeek` (from `@ts-capture/svelte/runes`) reads a `$state` proxy through
`svelte/internal/client.snapshot`, an internal Svelte API; if Svelte makes
`snapshot` public, the helper can move to it.

## License

MIT.
