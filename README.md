# ts-capture

[![CI](https://github.com/lelle/ts-capture/actions/workflows/ci.yml/badge.svg)](https://github.com/lelle/ts-capture/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)

> **Turn runtime values into TypeScript types — and check existing types against them.**

ts-capture watches how your code is called — in tests, in dev, in the
browser — and writes the types it saw back into your source. It also flags
existing types that the run contradicts.

**[▶ Try it in the browser](https://lelle.github.io/ts-capture/playground/)** — no install

![An order form whose code has no types. The ts-capture plugin is added to the Vite config, two orders are placed in the browser, and `ts-capture apply` writes four named types and six annotations into the source, taking type coverage from 77% to 100%.](docs/assets/demo.webp)

The recording is made by [`pnpm demo`](packages/demo), which runs every step
for real; nothing in it is written by hand.

> 0.x pre-release · rewrites your source — commit first.
> See [Before you run it](#before-you-run-it).

## How it works

```ts
// Before — implicit any
function greet(name) {
  return "Hello, " + name;
}
greet("World");
```

Run your tests with ts-capture loaded, then `ts-capture apply types.json`:

```ts
// After
function greet(name: string): string {
  return "Hello, " + name;
}
greet("World");
```

## Quick start (with Vitest)

```sh
npm install --save-dev @ts-capture/vite @ts-capture/core
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import tsCapture from "@ts-capture/vite";

export default defineConfig({
  plugins: [tsCapture()],
});
```

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
# → per-process observations collected under ./.ts-capture/
#   (working files, not source — gitignore them)

npx ts-capture merge ./.ts-capture --out types.json
# → consolidate dumps into one types.json (vitest's pool may emit
#   multiple per-process files; merge before apply)

npx ts-capture apply types.json --dry-run
# → preview what would change

npx ts-capture apply types.json
# → write inferred types back to source files
```

Read the diff before you keep it
([review & apply safely](docs/how-to/review-and-apply-safely.md)). Test files
are skipped; other files to skip go under
[`apply.skipFiles`](docs/reference/configuration.md#apply).

## When it helps (and when it doesn't)

ts-capture shines on untyped or partially-typed code, in-progress TS
migrations, and callback-heavy code. It helps least on already-typed code,
library public API surfaces, and generic-heavy code: a type is only as good as
the calls the tests made. See
[Why runtime observation](docs/explanation/why-runtime-observation.md),
[What it cannot infer](docs/explanation/what-it-cannot-infer.md), and
[Pair with TypeStat](docs/how-to/pair-with-typestat.md) for removing the
annotations TypeScript did not need.

## Prior art

[TypeWiz](https://github.com/mockdeep/typewiz) (Uri Shaked, archived 2021)
pioneered the idea of collecting types at runtime and writing them back into
TypeScript source, and is the direct inspiration for ts-capture.

## Before you run it

ts-capture rewrites your source files, runs your getters while it observes,
and writes what it saw to disk. Commit first, and read
[what it does to your project](docs/explanation/what-it-does-to-your-project.md).

## Documentation

Full docs live in **[`docs/`](docs/README.md)**, organized by intent
([Diátaxis](https://diataxis.fr/)), and on the site at
[lelle.github.io/ts-capture/docs](https://lelle.github.io/ts-capture/docs/):

- **Learn** — [How it works](docs/explanation/how-it-works.md) ·
  [Getting started](docs/tutorials/getting-started.md)
- **Do** — [how-to guides](docs/README.md) (Vite/Vitest, Svelte, Jest, …)
- **Look up** — [CLI](docs/reference/cli.md) ·
  [Configuration](docs/reference/configuration.md)
- **Understand** — [Why runtime observation](docs/explanation/why-runtime-observation.md) ·
  [What it cannot infer](docs/explanation/what-it-cannot-infer.md) ·
  [What it does to your project](docs/explanation/what-it-does-to-your-project.md)

## License

[MIT](LICENSE)
