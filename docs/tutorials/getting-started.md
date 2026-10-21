# Getting started

This tutorial takes you from zero to a successful `apply` on a tiny project,
using **Vitest**. You'll instrument code, run it, and watch ts-capture write a
real type back into your source.

## What you need

- Node 20 or later.
- Vitest 1 or later, which brings the Vite 5 the plugin needs. A folder with
  `vitest` installed and one `*.spec.ts` is enough.
- TypeScript source files (`.ts` / `.tsx`).
- git, with a clean working tree: step 6 writes into your source files.

A different setup? Each guide walks the same steps for its own:
[Jest (Babel)](../how-to/use-with-jest-babel.md) ·
[Svelte](../how-to/use-with-svelte.md) ·
[Vite dev server](../how-to/use-with-vite-vitest.md#browser-dev-sessions) ·
[no bundler (plain Node)](../how-to/use-without-a-bundler.md).

## 1. Install

```sh
npm install --save-dev @ts-capture/vite @ts-capture/core
```

## 2. Register the plugin

Add ts-capture to your `vitest.config.ts`:

```ts title="vitest.config.ts"
import { defineConfig } from "vitest/config";
import tsCapture from "@ts-capture/vite";

export default defineConfig({
  plugins: [tsCapture()],
});
```

The plugin instruments your `.ts`/`.tsx` files in memory — your files on disk
are not touched during the test run.

## 3. Start from untyped code

Say you have this function and a test that exercises it:

```ts title="src/greet.ts"
export function greet(name) {
  return "Hello, " + name;
}
```

```ts title="src/greet.spec.ts"
import { expect, test } from "vitest";
import { greet } from "./greet";

test("greets", () => {
  expect(greet("World")).toBe("Hello, World");
});
```

`name` is implicitly `any` — that's what we'll fix.

## 4. Run the tests with collection on

Point ts-capture at an output directory and run your suite as usual:

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
```

After the run, `./.ts-capture/` holds one or more
`ts-capture-types-<uuid>.json` dump files — the runtime observations.

These are working files, not source. Add them to `.gitignore`:

```gitignore title=".gitignore"
.ts-capture/
types.json
types.json.applied
```

## 5. Merge the dumps

```sh
npx ts-capture merge ./.ts-capture --out types.json
```

This consolidates every dump into a single `types.json`.

## 6. Preview, then apply

Always preview first:

```sh
npx ts-capture apply types.json --dry-run
```

When the preview looks right, write the changes:

```sh
git status --porcelain   # expect no output — nothing uncommitted to lose
npx ts-capture apply types.json
git diff                 # everything ts-capture changed, ready for review
```

`src/greet.ts` now carries the observed type:

```ts title="src/greet.ts (after apply)"
export function greet(name: string): string {
  return "Hello, " + name;
}
```

## What you just did

You ran the full **observe → merge → apply** pipeline. The type wasn't guessed
statically — `name` became `string` because the test actually called `greet`
with a string. For the why behind each stage, read
[How it works](../explanation/how-it-works.md).

## Next steps

- Running on a real, existing codebase? Read
  [Review & apply safely](../how-to/review-and-apply-safely.md) first.
- Want literal types (`"a"`), pattern detection, or other tuning? See the
  [Configuration reference](../reference/configuration.md).
