# Examples

Before and after: what ts-capture wrote into real code, including the results
a reviewer should change and the places it left alone.

The page is built from [`examples.json`](examples.json):

```sh
pnpm examples        # writes site/, with examples/ and playground/ under it
```

Nothing in `examples.json` is written by hand. Each entry is cut from the
diff of an actual `apply` run, with the project, its commit and the ts-capture
revision recorded beside it. The file is regenerated from those runs, not
edited: a change to what ts-capture writes shows up as a diff in this file.

## How it decides

`site/how-it-decides/` is a map of what `apply` does to a position: one card
per outcome (written, or each reason it leaves a position alone), for each
kind of position. Each card is a small file from
[`cells.ts`](../../packages/examples-site/src/how-it-decides/cells.ts), run
through the same applier as the playground when the page is built;
`cells.spec.ts` checks that every card still ends where it says, and names
the function in `packages/core/src` that decides it. A card links to that
function, to the test, to the real examples in its cell, and opens in the
playground. Only parameters are mapped so far.

## Playground

`site/playground/` runs ts-capture in the visitor's browser, with no server
behind it: write a file, call its functions, and see the observed types
written back. It is built on
[`@ts-capture/core/browser`](../reference/packages.md), so it runs the same
applier and type-check gate as the CLI, on one file with only the JavaScript
standard library. The code runs in a worker that is stopped after ten
seconds.

To look at either page locally, serve the folder; the playground does not
work from a `file:` address:

```sh
pnpm examples && python3 -m http.server --directory site 8000
```

`.github/workflows/pages.yml` publishes both pages to GitHub Pages once Pages is
switched on for the repository with "GitHub Actions" as its source.
