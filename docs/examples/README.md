# Examples

Before and after: what ts-capture wrote into real code, including the results
a reviewer should change and the places it left alone.

The page is built from [`examples.json`](examples.json):

```sh
pnpm examples        # writes site/index.html
```

Nothing in `examples.json` is written by hand. Each entry is cut from the
diff of an actual `apply` run, with the project, its commit and the ts-capture
revision recorded beside it. The file is regenerated from those runs, not
edited: a change to what ts-capture writes shows up as a diff in this file.

`.github/workflows/pages.yml` publishes the page to GitHub Pages once Pages is
switched on for the repository with "GitHub Actions" as its source.
