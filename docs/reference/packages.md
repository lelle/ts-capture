# Packages

ts-capture is a pnpm monorepo. Most users install `@ts-capture/core` plus one
integration package matching their stack.

| Package                                                   | Use when…                                                                          | How-to                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`@ts-capture/core`](../../packages/core)                 | You want the engine + CLI (always required)                                        | —                                                         |
| [`@ts-capture/vite`](../../packages/vite)                 | You use Vite or Vitest                                                             | [Use with Vite/Vitest](../how-to/use-with-vite-vitest.md) |
| [`@ts-capture/svelte`](../../packages/svelte)             | You use SvelteKit or standalone Svelte 5 with Vitest                               | [Use with Svelte](../how-to/use-with-svelte.md)           |
| [`@ts-capture/babel-plugin`](../../packages/babel-plugin) | Your test runner uses Babel (Jest, Vite-with-Babel, webpack)                       | [Use with Jest (Babel)](../how-to/use-with-jest-babel.md) |
| [`@ts-capture/esbuild`](../../packages/esbuild)           | You bundle with esbuild / tsup                                                     | —                                                         |
| [`@ts-capture/core/preload`](../../packages/core)         | Zero build-config collection — `NODE_OPTIONS='--require @ts-capture/core/preload'` | —                                                         |
| [`@ts-capture/skills`](../../packages/skills)             | Your coding agent supports `SKILL.md`-based skills                                 | —                                                         |

## How the pieces fit

- **`core`** is the engine: the instrumenter, the type collector/merger, the
  applier, and the `ts-capture` CLI ([CLI reference](cli.md)).
- The **integration packages** (`vite`, `svelte`, `babel-plugin`, `esbuild`)
  exist only to instrument your code inside the build tool you already run, and
  to supply the runtime collector. They all feed the same `core` merge/apply
  steps.
- **`core/preload`** (and the Jest-targeted `core/setup`) install the runtime
  collector without a bundler.

Each integration package's README has stack-specific detail; the how-to guides
above are the task-focused entry points.
