# Use without a bundler

Goal: collect types when you run plain Node — no Vite, Babel, or other transform
in the chain (a script, a small CLI, `node --experimental-strip-types`, etc.).
There are two paths; pick by whether you want a one-shot rewrite or the
reviewable merge/apply pipeline.

## Path A — `register` (zero-config, one shot)

`@ts-capture/core/register` is a Node `--import` loader that instruments
`.ts`/`.tsx` files as they load, collects observations, and **applies the
inferred types straight back to your source on process exit**:

```sh
node --import @ts-capture/core/register src/app.ts
```

That single command instruments, runs, and rewrites your source files when the
process exits. There is no `types.json` and **no `--dry-run` preview** — it edits
in place.

> **Commit first.** This is the least reversible path in ts-capture: your only
> safety net is source control. Run it on a clean working tree, then `git diff`
> to see what happened and `git checkout .` if you want it gone.

**Caveat:** `register` installs a Node ESM loader. Most test runners
(Jest, Vitest, mocha+ts-node) install their _own_ loader earlier in the chain
and shadow it, so `register` does not work end-to-end under them — use the
matching integration package instead ([Vite/Vitest](use-with-vite-vitest.md),
[Jest/Babel](use-with-jest-babel.md)), or Path B below.

## Path B — `preload` + manual instrument (reviewable pipeline)

`@ts-capture/core/preload` only installs the runtime collector (it writes
per-process dumps); it does **not** instrument your source. Instrument
explicitly first, then run with the preload, then use the normal merge/apply
pipeline — which gives you `--dry-run` and config control:

```sh
# 1. Instrument the files you want observed (rewrites them — commit first)
npx ts-capture instrument src/app.ts --in-place

# 2. Run with the collector preloaded
TS_CAPTURE_TYPES_DIR=./.ts-capture \
  NODE_OPTIONS='--require @ts-capture/core/preload' \
  node src/app.ts

# 3. Merge dumps, preview, apply
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run
npx ts-capture apply types.json
```

Restore the instrumented files (e.g. `git checkout`) before step 3 so `apply`
lands at the original source offsets — see
[Don't edit source between observe and apply](review-and-apply-safely.md#dont-edit-source-between-observe-and-apply).
Restoring them also keeps ts-capture's runtime hooks out of your commits: the
step-1 output is a diagnostic artefact, never something to ship.

## Jest with jsdom — use `core/setup`

The `NODE_OPTIONS` preload sets globals on Node's `process`, which a
`jest-environment-jsdom` worker doesn't inherit (each test file gets a fresh vm
context). For that case, install the collector _inside_ the sandbox via
`setupFilesAfterEnv`:

```js title="jest.config.js"
module.exports = {
  setupFilesAfterEnv: ["@ts-capture/core/setup"],
};
```

(For the common Jest path, prefer [Use with Jest (Babel)](use-with-jest-babel.md),
where Babel does the instrumentation.)

## Which path?

| You want…                                                       | Use                                         |
| --------------------------------------------------------------- | ------------------------------------------- |
| A quick one-shot rewrite of a script you run with `node`        | Path A (`register`)                         |
| A preview (`--dry-run`), config flags, or the standard pipeline | Path B (`preload`)                          |
| To collect under a test runner                                  | The runner's integration package, not these |

## Next

- [Review & apply safely](review-and-apply-safely.md)
- [CLI reference](../reference/cli.md) · [Configuration](../reference/configuration.md)
