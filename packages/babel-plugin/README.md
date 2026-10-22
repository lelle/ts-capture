# @ts-capture/babel-plugin

Babel plugin for [ts-capture](../core) — collects the types your code is called
with when Jest or another Babel build runs it.

Mirrors the [`@istanbuljs/babel-plugin-istanbul`](https://github.com/istanbuljs/babel-plugin-istanbul)
pattern: the user's existing Babel chain (Jest preset, Vite-with-Babel, webpack,
etc.) does the instrumentation, eliminating loader-integration as a problem class.

Instrumenting at compile time, inside the build tool you already run, avoids
the Node loader chain that Jest, Vitest and ts-node each take over first.

## Install

```sh
npm install --save-dev @ts-capture/babel-plugin @ts-capture/core
```

## Use

Two lines, added to the config you have. The plugin, beside your presets:

```diff
 // babel.config.js
 module.exports = {
   presets: [["@babel/preset-env", { targets: { node: "current" } }], "@babel/preset-typescript"],
+  plugins: ["@ts-capture/babel-plugin"],
 };
```

And the collector, in Jest's `setupFiles`:

```diff
 // jest.config.js
 module.exports = {
   testEnvironment: "node",
+  setupFiles: ["@ts-capture/babel-plugin/runtime"],
 };
```

**Full guide:** [Use with Jest (Babel)](../../docs/how-to/use-with-jest-babel.md)
— what the runtime line does, collecting, merging and applying.

[`examples/jest/`](examples/jest) is a small project wired this way. What it
gives:

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
