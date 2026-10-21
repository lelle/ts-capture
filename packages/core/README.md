# ts-capture

The engine and the `ts-capture` CLI: it turns what your tests observed into
type annotations in your source. The integrations below collect the
observations; this package merges and applies them.

```sh
npm install --save-dev @ts-capture/core
```

```sh
# 1. run your tests with an integration installed, so observations are written
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
# 2. merge them, preview, apply
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run
npx ts-capture apply types.json
```

`apply` edits your source: run it from a committed working tree.

- **Start:** [Getting started](../../docs/tutorials/getting-started.md)
- **Your test runner:** [Vite / Vitest](../../docs/how-to/use-with-vite-vitest.md) ·
  [Jest (Babel)](../../docs/how-to/use-with-jest-babel.md) ·
  [Svelte](../../docs/how-to/use-with-svelte.md) ·
  [no bundler](../../docs/how-to/use-without-a-bundler.md) ·
  [esbuild / tsup](../esbuild)
- **Look up:** [CLI](../../docs/reference/cli.md) ·
  [Configuration](../../docs/reference/configuration.md) ·
  [API](../../docs/reference/api.md)
- **Before you run it:** [Review & apply safely](../../docs/how-to/review-and-apply-safely.md)

## License

MIT.
