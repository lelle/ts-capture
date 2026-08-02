# ts-capture documentation

ts-capture observes how your code is actually called at runtime and writes the
inferred TypeScript types back into your source. It's a **process**, not just a
library — these docs are organized so you can find what you need by intent.

## Start here

- **About to run it?** ts-capture writes to your source files — commit your
  work first: [Review & apply safely](how-to/review-and-apply-safely.md).
- **New to ts-capture?** Read [How it works](explanation/how-it-works.md) for
  the mental model, then do the [Getting started tutorial](tutorials/getting-started.md).
- **Already know what it does?** Jump to a how-to:
  [Use with Vite/Vitest](how-to/use-with-vite-vitest.md) ·
  [Review & apply safely](how-to/review-and-apply-safely.md).
- **Looking up a flag or command?** See the
  [Configuration reference](reference/configuration.md).

## The four kinds of docs

This documentation follows the [Diátaxis](https://diataxis.fr/) model — each
page is one of four kinds, so it's clear whether you're learning, doing, or
looking something up.

### Tutorials — learning by doing

- [Getting started](tutorials/getting-started.md) — a guided first run, from
  install to a successful `apply`.

### How-to guides — task-focused

- [Use with Vite / Vitest](how-to/use-with-vite-vitest.md)
- [Use with Svelte 5](how-to/use-with-svelte.md)
- [Use with Jest (Babel)](how-to/use-with-jest-babel.md)
- [Use without a bundler](how-to/use-without-a-bundler.md)
- [Review & apply safely](how-to/review-and-apply-safely.md)
- [Pair with TypeStat](how-to/pair-with-typestat.md)

### Reference — facts

- [CLI](reference/cli.md) — every command and flag.
- [Configuration](reference/configuration.md) — every `infer.*` / `apply.*`
  flag, its default, and the config-file / CLI form.
- [Packages](reference/packages.md) — the package matrix and how they fit.

### Explanation — understanding

- [How it works](explanation/how-it-works.md) — observe → merge → apply.
- [Why runtime observation](explanation/why-runtime-observation.md) — the
  strategy, and when it helps vs hurts.
- [What it cannot infer](explanation/what-it-cannot-infer.md) — the limits and
  failure modes.
- [JSX element typing](explanation/jsx-element-typing.md) — how React elements
  are typed, and the boundary for other JSX frameworks.
