# Use with Jest (Babel)

Goal: collect types from a Jest suite (or any Babel-based setup — Vite-with-Babel,
webpack) by adding ts-capture to your existing Babel chain. Instrumentation
happens at compile time inside the build tool you already run, so there's no
loader-integration to fight.

```diff
- export function add(a, b) { return a + b; }
- export function isAdult(person) { return person.age >= 18; }
+ export function add(a: number, b: number): number { return a + b; }
+ export function isAdult(person: { age: number, name: string }): boolean { return person.age >= 18; }
```

## Install

```sh
npm install --save-dev @ts-capture/babel-plugin @ts-capture/core
```

## Add two lines to the config you have

The plugin goes into your Babel chain, beside the presets already there. Keep
those as they are: Jest needs what it needed before.

```diff title="babel.config.js"
 module.exports = {
   presets: [["@babel/preset-env", { targets: { node: "current" } }], "@babel/preset-typescript"],
+  plugins: ["@ts-capture/babel-plugin"],
 };
```

The collector goes into Jest's `setupFiles`:

```diff title="jest.config.js"
 module.exports = {
   testEnvironment: "node",
+  setupFiles: ["@ts-capture/babel-plugin/runtime"],
 };
```

It sets `globalThis.__tscptr__` in each test file and writes what the plugin's
calls report to disk as the tests run. Without the `setupFiles` line the suite
still passes and nothing is written: there is no error to tell you.

If your project already loads a setup file through `setupFiles`, you can put
`import "@ts-capture/babel-plugin/runtime";` at the top of it instead.

## Collect, merge, apply

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run   # preview
npx ts-capture apply types.json
```

Commit first; `apply` edits your source ([review & apply safely](review-and-apply-safely.md)).

Observations land in `${TS_CAPTURE_TYPES_DIR}/ts-capture-types-<id>.json`,
one file per test file under Jest.

`include` and `exclude` choose the files the plugin instruments; see the
[`@ts-capture/babel-plugin` README](../../packages/babel-plugin/README.md#options).

## Why the Babel plugin (not a Node loader)?

ts-capture's `--import @ts-capture/core/register` loader does not work
end-to-end on most popular OSS TS test setups, because every popular runner
(mocha+ts-node, Jest, Vitest, Vite) installs its own loader earlier in the Node
ESM chain. A Babel plugin sidesteps that entirely — instrumentation happens
inside the build tool you already run.

## Next

[Review & apply safely](review-and-apply-safely.md) ·
[Configuration](../reference/configuration.md)
