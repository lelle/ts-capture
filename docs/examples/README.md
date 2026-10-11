# Examples

Before and after: what ts-capture wrote into real code, including the results
a reviewer should change and the places it left alone.

The page is built from [`examples.json`](examples.json):

```sh
pnpm examples        # writes site/index.html and site/playground/
```

Nothing in `examples.json` is written by hand. Each entry is cut from the
diff of an actual `apply` run, with the project, its commit and the ts-capture
revision recorded beside it. The file is regenerated from those runs, not
edited: a change to what ts-capture writes shows up as a diff in this file.

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
