# @ts-capture/babel-plugin

Babel plugin for [ts-capture](../core) — automatic TypeScript type annotation via
runtime observation.

Mirrors the [`@istanbuljs/babel-plugin-istanbul`](https://github.com/istanbuljs/babel-plugin-istanbul)
pattern: the user's existing Babel chain (Jest preset, Vite-with-Babel, webpack,
etc.) does the instrumentation, eliminating loader-integration as a problem class.

## Why a Babel plugin?

The ts-capture evaluation found that ts-capture's
`--import @ts-capture/core/register` runtime mode does not work end-to-end on any of the
20 popular OSS TypeScript projects screened, because every popular TS test
setup (mocha+ts-node, Jest, Vitest, Vite) installs its own loader earlier in
the Node ESM chain.

A Babel plugin sidesteps the loader chain entirely: instrumentation happens
at compile time inside the build tool the user already runs.

## Install

```sh
npm install --save-dev @ts-capture/babel-plugin@next @ts-capture/core@next
```

## Use

`babel.config.js`:

```js
module.exports = {
  presets: ["@babel/preset-typescript"],
  plugins: ["@ts-capture/babel-plugin"],
};
```

Then in your test setup file (Jest `setupFiles`, Vitest `setupFiles`, etc.):

```ts
import "@ts-capture/babel-plugin/runtime";
```

After running tests, observations land in `${TS_CAPTURE_TYPES_DIR}/ts-capture-types-<pid>.json`.
Merge those and apply with the ts-capture CLI. `apply` edits your source — run
it from a committed working tree
([Review & apply safely](../../docs/how-to/review-and-apply-safely.md)):

```sh
ts-capture apply types.json --dry-run   # preview
ts-capture apply types.json
```

See `examples/jest/` for a working end-to-end example. Verified flow:

```diff
- export function add(a, b) { return a + b; }
- export function greet(name) { return `Hello, ${name}!`; }
- export function isAdult(person) { return person.age >= 18; }
+ export function add(a: number, b: number): number { return a + b; }
+ export function greet(name: string): string { return `Hello, ${name}!`; }
+ export function isAdult(person: { age: number, name: string }): boolean { return person.age >= 18; }
```

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

## How it works

1. The plugin's `Program.enter` hook receives each TS file Babel processes.
2. It calls `instrumentSource(source, filename, { skipTscptrDeclarations: true })` (from `@ts-capture/core`).
3. The instrumented source is re-parsed back into a Babel AST.
4. The original program AST is replaced with the instrumented one.
5. Subsequent Babel plugins/presets see the instrumented code as if the user
   had written it that way.

The runtime side (`@ts-capture/babel-plugin/runtime`) sets `globalThis.__tscptr__` and
dumps observations to disk on process exit / SIGTERM / 500 ms tick.

## License

MIT.
