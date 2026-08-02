# ts-capture

Automatically discover and add missing TypeScript type annotations by observing runtime types.

> **Status:** Core complete. CLI, Node runner, and Vite plugin implemented.

> **⚠️ This package writes to your source files.** `apply`,
> `instrument --in-place` and the `core/register` runner all edit code on disk.
> Commit your work before running them, so every change is a reviewable
> `git diff` you can undo with `git checkout .`.

## Install

```bash
npm install @ts-capture/core@next
```

## Usage

### CLI

```bash
# Instrument a file (outputs to stdout)
ts-capture instrument src/app.ts

# Instrument in-place
ts-capture instrument --in-place src/app.ts

# Apply collected types to source files
ts-capture apply collected-types.json

# Report type coverage
ts-capture coverage tsconfig.json
```

### Node runner

The runner applies types on process exit, in place, with no preview.

```bash
# Run a script with automatic type collection and application
node --import @ts-capture/core/register src/main.ts

# Works with any runner
mocha --import @ts-capture/core/register test/**/*.spec.ts
```

### Vite plugin

```bash
npm install @ts-capture/vite@next
```

```typescript
// vite.config.ts
import tsCapture from "@ts-capture/vite";

export default defineConfig({
  plugins: [
    tsCapture({
      apply: true, // auto-apply types on collection
      exclude: /\.spec\.ts$/, // skip test files
    }),
  ],
});
```

### Programmatic API

```typescript
import {
  instrumentSource,
  applyTypesToFile,
  createCollectionContext,
  typeCoverage,
} from "@ts-capture/core";

// Instrument source code
const instrumented = instrumentSource(source, "app.ts");

// Create a scoped collection context (no global state)
const ctx = createCollectionContext();

// ... execute instrumented code, collecting types via ctx ...

// Apply collected types back to source
const annotated = applyTypesToFile(source, ctx.getCollectedTypes(), {});
```

## How it works

```
Source Code ──► [Instrument] ──► Instrumented Code ──► [Execute + Collect] ──► Type Data ──► [Apply] ──► Annotated Source
```

1. **Instrument** — AST transformer inserts `__tscptr__()` tracking calls for unannotated parameters
2. **Collect** — Runtime snippet observes actual values and records their types
3. **Apply** — Collected types are written back as annotations in the original source

## Packages

| Package                                        | Description                      |
| ---------------------------------------------- | -------------------------------- |
| `@ts-capture/core` (this package)              | Core library + CLI + Node runner |
| `@ts-capture/vite` (`../vite`)                 | Vite plugin                      |
| `@ts-capture/babel-plugin` (`../babel-plugin`) | Babel plugin (Jest etc.)         |
| `@ts-capture/core/preload` (this package)      | `NODE_OPTIONS=--require` shim    |
| `@ts-capture/svelte` (`../svelte`)             | Svelte preprocessor              |
| `@ts-capture/esbuild` (`../esbuild`)           | esbuild plugin (tsup etc.)       |

See the [root README](../../README.md) for the full overview.

## Tech Stack

TypeScript 6, Vitest, Prettier, oxlint, ESM-only, Node 22+

## Development

```bash
npm test              # run tests
npm run test:coverage # with coverage report
npm run check         # format + lint + build + test
```

TDD with Red-Green-Refactor. All work tracked as GitHub issues.

## License

MIT
