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
npm install --save-dev @ts-capture/babel-plugin@next @ts-capture/core@next
```

## Add the plugin to your Babel chain

```js title="babel.config.js"
module.exports = {
  presets: ["@babel/preset-typescript"],
  plugins: ["@ts-capture/babel-plugin"],
};
```

## Install the runtime collector

In your test setup file (Jest `setupFiles`, Vitest `setupFiles`, …):

```ts title="jest.setup.ts"
import "@ts-capture/babel-plugin/runtime";
```

This sets `globalThis.__tscptr__` and dumps observations to disk on process
exit / SIGTERM / a 500 ms tick.

## Collect, merge, apply

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run   # preview
npx ts-capture apply types.json
```

`apply` edits your source — run it from a committed working tree
([Review & apply safely](review-and-apply-safely.md)).

Observations land in `${TS_CAPTURE_TYPES_DIR}/ts-capture-types-<pid>.json`.

## Options

```js
plugins: [
  [
    "@ts-capture/babel-plugin",
    {
      exclude: /node_modules|\.spec\.ts$/, // skip files matching this regex
      include: /\.(ts|tsx)$/, // override default file extensions
    },
  ],
];
```

## Why the Babel plugin (not a Node loader)?

ts-capture's `--import @ts-capture/core/register` loader does not work
end-to-end on most popular OSS TS test setups, because every popular runner
(mocha+ts-node, Jest, Vitest, Vite) installs its own loader earlier in the Node
ESM chain. A Babel plugin sidesteps that entirely — instrumentation happens
inside the build tool you already run.

## Next

- [Review & apply safely](review-and-apply-safely.md) before applying on a real
  codebase.
- [Configuration reference](../reference/configuration.md).
