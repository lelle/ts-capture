# How it works

ts-capture turns implicit `any` into real types by **watching your code run**
— usually under your existing test suite — and writing back the types it
observed. There is no static guessing: a parameter becomes `string` because it
was actually called with a string.

```ts title="Input"
// Before — implicit any on the parameter
function greet(name) {
  return "Hello, " + name;
}
greet("World");
```

```ts title="Expected"
// After apply — the observed type is written back
function greet(name: string): string {
  return "Hello, " + name;
}
greet("World");
```

The pipeline has three stages: **observe → merge → apply.**

## 1. Observe

Your source is _instrumented_ — wrapped so each function records the runtime
types of its arguments and return value — and then run. As it runs, each
process writes its observations to a per-process JSON dump named
`ts-capture-types-<uuid>.json` under `TS_CAPTURE_TYPES_DIR`.

There are three ways to instrument, depending on your stack — pick one:

| Way            | How                                                                                 | When                                                                         |
| -------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Bundler plugin | `@ts-capture/vite` (Vitest/Vite), `@ts-capture/esbuild`, `@ts-capture/babel-plugin` | You run tests through a bundler/transform. Source on disk is never modified. |
| Node preload   | `NODE_OPTIONS='--require @ts-capture/core/preload'`                                 | No build tooling — plain `node`, ts-node, Mocha, etc.                        |
| CLI, in place  | `ts-capture instrument <file> --in-place`                                           | One-off / scripted runs; rewrites the file (commit it first).                |

The plugin and preload paths instrument **in memory**, so code that lints,
format-checks, or type-checks on-disk source before testing stays green.

### Observation reads your values — including getters

To describe a value, the walker **reads it**: every own enumerable property of
an object, every element of an array, `Map` or `Set`. That means:

- **Getters run.** A property backed by a getter is invoked, in addition to
  whatever your own code does. One that lazily initializes, counts accesses,
  mutates, or issues a request will do so more often with ts-capture loaded.
- **Proxy traps fire.** Observed objects are probed for framework markers, so a
  `Proxy`'s `get` handler sees traffic it wouldn't otherwise.
- **Throwing accessors are swallowed.** A getter that throws doesn't crash the
  run — the position falls back to `unknown` — but the side effect has already
  happened, and nothing reports the failure.

The walk is depth-limited, but not side-effect free: treat an instrumented run
as a diagnostic run, not as your normal CI run — and never attach one to a
production process.

## 2. Merge

A real test run produces **many** dump files — Vitest's `forks` pool emits one
per worker, for example. `ts-capture merge` consolidates them into a single
`types.json`:

```sh
npx ts-capture merge ./.ts-capture --out types.json
```

Merging is also where observations of the _same_ position from different runs
are combined — e.g. a parameter seen as both `string` and `number` becomes
`string | number`.

## 3. Apply

`ts-capture apply` reads `types.json` and writes the inferred annotations into
your source files:

```sh
npx ts-capture apply types.json --dry-run   # preview, write nothing
npx ts-capture apply types.json             # write the changes
```

This is the stage that **modifies your code on disk**, so run it from a clean,
committed working tree — the apply then reads as a `git diff` you can review
in full and revert with `git checkout .`.

Apply is conservative by design:

- **It never overwrites an existing annotation** — only empty positions are
  filled.
- **A type-check gate** (`infer.typecheckVerify`, on by default) drops any
  candidate annotation that would introduce a new TypeScript error.
- **It is idempotent** — a `<types.json>.applied` manifest records what was
  written so re-running is a no-op (use `--force` to bypass).
- **Test files are skipped** by default (`--include-tests` to opt in).

Because apply only fills gaps and is gated by the type-checker, a run that
finds nothing safe to add changes nothing.

## Where to go next

- Do it end to end: [Getting started](../tutorials/getting-started.md).
- Tune what gets emitted: [Configuration reference](../reference/configuration.md).
- Apply on an existing codebase safely:
  [Review & apply safely](../how-to/review-and-apply-safely.md).
