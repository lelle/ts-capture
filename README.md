# ts-capture

[![CI](https://github.com/lelle/ts-capture/actions/workflows/ci.yml/badge.svg)](https://github.com/lelle/ts-capture/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)

> **Capture runtime values, shape them as TypeScript types.**

ts-capture observes how your code is actually called at runtime — in tests, in
dev, in the browser — and writes inferred TypeScript types back into your
source. Turns implicit `any` into precise types, automatically.

> **🚧 Pre-release — `@next` only.** The packages are published to npm
> under the `next` dist-tag exclusively; there is no stable release, and
> a plain `npm install @ts-capture/<pkg>` will not resolve. We're
> deliberately holding back a stable `latest` until code, API, test
> coverage, and documentation meet a quality bar that respects the first
> impression. No public timeline.

> **0.x — API may change between minor versions.** Hobby/research
> project; best-effort maintenance.

> **⚠️ ts-capture is not a passive tool.** It rewrites your source files, runs
> your getters while observing, and writes observed data to disk — by default
> into your temp directory. Commit your work first, and read [Risks](#risks)
> before pointing it at a real codebase.

## How it works

```ts
// Before — implicit any
function greet(name) {
  return "Hello, " + name;
}
greet("World");
```

Run your tests with ts-capture loaded, then `ts-capture apply types.json`:

```ts
// After
function greet(name: string): string {
  return "Hello, " + name;
}
greet("World");
```

## Documentation

Full docs live in **[`docs/`](docs/README.md)**, organized by intent
([Diátaxis](https://diataxis.fr/)):

- **Learn** — [How it works](docs/explanation/how-it-works.md) ·
  [Getting started](docs/tutorials/getting-started.md)
- **Do** — [how-to guides](docs/README.md) (Vite/Vitest, Svelte, Jest, …)
- **Look up** — [CLI](docs/reference/cli.md) ·
  [Configuration](docs/reference/configuration.md)
- **Understand** — [Why runtime observation](docs/explanation/why-runtime-observation.md) ·
  [What it cannot infer](docs/explanation/what-it-cannot-infer.md)

## Packages

| Package                                             | Use when...                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`@ts-capture/core`](packages/core)                 | You want the engine + CLI                                                             |
| [`@ts-capture/babel-plugin`](packages/babel-plugin) | Your test runner uses Babel (Jest, Vite-with-Babel, webpack)                          |
| [`@ts-capture/vite`](packages/vite)                 | You use Vite or Vitest                                                                |
| [`@ts-capture/svelte`](packages/svelte)             | You use SvelteKit or standalone Svelte 5 with Vitest                                  |
| [`@ts-capture/core/preload`](packages/core)         | You want zero build-config — just `NODE_OPTIONS='--require @ts-capture/core/preload'` |
| [`@ts-capture/skills`](packages/skills)             | Your coding agent supports `SKILL.md`-based skills                                    |

## Quick start (with Vitest)

> Pre-release: note the `@next` tags — see the notice above.

```sh
npm install --save-dev @ts-capture/vite@next @ts-capture/core@next
```

```ts
// vite.config.ts
import { defineConfig } from "vitest/config";
import { tsCapturePlugin } from "@ts-capture/vite";

export default defineConfig({
  plugins: [tsCapturePlugin()],
  test: {
    // Recommended for non-trivial codebases: vitest's default pool
    // (`forks`) was chosen for stability, not speed. Each fork
    // re-initializes ts-capture's plugin pipeline. On suites with many
    // spec files that overhead compounds. singleFork keeps test
    // isolation cheap but routes all specs through one process.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
```

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
# → per-process observations collected under ./.ts-capture/
#   (working files, not source — gitignore them; see Risks below)

npx ts-capture merge ./.ts-capture --out types.json
# → consolidate dumps into one types.json (vitest's pool may emit
#   multiple per-process files; merge before apply)

npx ts-capture apply types.json --dry-run
# → preview what would change

npx ts-capture apply types.json
# → write inferred types back to source files (commit first — this edits
#   your files on disk)
```

`--dry-run` is recommended on existing codebases — see [Known limitations](#known-limitations).
Test files (`*.spec.*`, `*.test.*`) are skipped by default; pass `--include-tests` to opt in.
To skip more files (or re-include some), add gitignore-style globs under
`apply.skipFiles` in `ts-capture.config.json` — they stack on top of the
built-in test default (last match wins; a leading `!` re-includes).
Globs support `*`, `**`, `?`, and brace alternation (`{a,b}`):

```json title="Input"
{
  "apply": {
    "skipFiles": ["src/**/*.{gen,generated}.ts", "!src/generated/keep.ts"]
  }
}
```

## When it helps (and when it doesn't)

ts-capture shines on untyped or partially-typed code, in-progress TS
migrations, and callback-heavy code. It helps least on already-typed code,
library public API surfaces, and generic-heavy code. See
[Why runtime observation](docs/explanation/why-runtime-observation.md) for the
full picture, and [What it cannot infer](docs/explanation/what-it-cannot-infer.md)
before running `apply` on production code.

## Pair with TypeStat

ts-capture and [TypeStat](https://github.com/JoshuaKGoldberg/TypeStat) cover
disjoint slices of any-removal — ts-capture fills `any` that's only knowable at
runtime; TypeStat removes redundant annotations and converts JS→TS. Run
TypeStat first, ts-capture second. See
[Pair with TypeStat](docs/how-to/pair-with-typestat.md).

## Prior art

[TypeWiz](https://github.com/mockdeep/typewiz) (Uri Shaked, archived 2021)
pioneered the idea of collecting types at runtime and writing them back into
TypeScript source, and is the direct inspiration for ts-capture.

## Performance

ts-capture's transform-time instrumentation adds **18-31% wall-time
overhead** on synthetic benches (linear axes — file count, call count,
type complexity). On the hono test suite (3457 tests, 284 source files)
it runs in 246s with ts-capture observation enabled vs 33s baseline —
~7.5× slower in absolute terms but completes cleanly with all tests
passing post-fix.

For context: Ben Coe (Istanbul/nyc/c8 maintainer) reports Node.js's
own test suite is ~300% slower with Istanbul transform-time
instrumentation, and ~20% slower with V8 native coverage
([Rethinking JavaScript Test Coverage](https://medium.com/the-node-js-collection/rethinking-javascript-test-coverage-5726fb272949)).
ts-capture's overhead is in V8-native territory, an order of magnitude
better than transform-time coverage.

### Why not V8 native (c8-style)?

ts-capture is forced to use transform-time instrumentation because shape
observation requires actual runtime values, not just hit counts. V8's
coverage protocol exposes line/branch hit counts only — useful for
coverage tools like c8, but insufficient for a tool that needs to
walk values to compute their structural type. We inherit transform-
time's known weaknesses (per-call overhead, language-feature lag,
sourcemap complexity) by necessity.

## What's supported

|                 | First-class (CI) | Best-effort     |
| --------------- | ---------------- | --------------- |
| **Node**        | 20+              | <20             |
| **OS**          | Linux, macOS     | Windows         |
| **JS-runtime**  | Node             | Bun, Deno       |
| **Test-runner** | Vitest, Jest     | Mocha, Tap, AVA |

## Configuration

ts-capture reads an optional `ts-capture.config.json`, discovered by walking
up from the working directory. Inference and apply behavior can be set in that
file or overridden ad hoc on the CLI — both reach the same options.

```json title="ts-capture.config.json"
{
  "infer": {
    "literal": { "string": true, "stringMaxLength": 24 }
  },
  "apply": {
    "skipFiles": ["src/**/*.generated.ts"]
  }
}
```

```sh
# Equivalent ad-hoc CLI override (coerced: true/false → boolean, numeric → number):
npx ts-capture apply types.json --infer.literal.string=true --infer.literal.stringMaxLength=24
```

Every flag defaults to today's behavior — the config layer is a no-op until
you opt in. See the **[configuration reference](docs/reference/configuration.md)** for
every `infer.*` / `apply.*` flag, its default, and what it does.

## Status

**Release status: Pre-release (`@next` dist-tag only).** Capability-level
state below reflects what works _internally_ — a stable `latest` release is
gated on the quality work described in the Pre-release notice above.

| Capability                | Where                      | Internal status                                                                                                 |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Type inference engine     | `@ts-capture/core`         | ✅ Functional; 1182-test suite, CI-gated                                                                        |
| Babel-plugin integration  | `@ts-capture/babel-plugin` | ✅ Validated on real-world Jest projects                                                                        |
| Vite + Vitest integration | `@ts-capture/vite`         | ✅ Functional in Vitest mode; validated on hono (4391 tests, Δ failed: 0)                                       |
| Svelte 5 integration      | `@ts-capture/svelte`       | ✅ Preprocessor + offset-aware apply + `$state` runes bridge (`attachPeek`)                                     |
| Node `NODE_OPTIONS` shim  | `@ts-capture/core/preload` | ✅ Collection validated; threads-pool dump-loss fixed                                                           |
| Literal-type emission     | `@ts-capture/core`, opt-in | ✅ Off by default; emits literals (`"a"`/`42`/`true`) instead of widening — see [Configuration](#configuration) |

## Risks

ts-capture is not a passive observer the way a linter or type-checker is. It
does three things to a real system:

### 1. It rewrites your source files

`apply`, `instrument --in-place` and `core/register` all edit code on disk;
`register` and the Vite dev server's `apply: true` do it with **no preview at
all**. Run from a committed working tree so every change is a reviewable
`git diff`. See
[Review & apply safely](docs/how-to/review-and-apply-safely.md).

### 2. Observing a value means reading it

To describe a value, ts-capture reads it — every own enumerable property, every
array/`Map`/`Set` element. During an instrumented run:

- **Getters execute.** Including ones that mutate state or issue requests —
  and more often than your own code invokes them.
- **`Proxy` get-traps fire,** since observed objects are probed for framework
  markers.
- **A throwing accessor is swallowed** — the failure leaves no trace.

Treat an instrumented run as a diagnostic run — and never attach one to a
production process. See
[How it works](docs/explanation/how-it-works.md#observation-reads-your-values--including-getters).

### 3. Observed data is written to disk

Each process writes what it observed to a per-process dump, continuously and
again on exit. **With `TS_CAPTURE_TYPES_DIR` unset those dumps land in
`os.tmpdir()`**, and nothing ever deletes them.

A dump is a partial structural map of a private codebase — the source-file
paths the bundler saw (usually absolute), parameter names, and type shapes down
to your objects' property _key names_ — and with `infer.literal.*` enabled, the
[**observed values themselves**](docs/how-to/review-and-apply-safely.md#observed-values-in-your-output).
Treat it as data, not build output: point `TS_CAPTURE_TYPES_DIR` inside the
project, gitignore `.ts-capture/` / `types.json` / `types.json.applied`, and
delete the dumps when done.

**Transport.** In browser mode observations leave the page: `POST`ed to the
Vite dev server by default (unauthenticated, like the rest of the dev server),
or to whatever URL `transports` / `TS_CAPTURE_TRANSPORT_URL` configures — see
[What the dev server exposes](packages/vite/README.md#what-the-dev-server-exposes).
Point them only at a collector you control, and never ship an instrumented
build.

## Known limitations

Runtime observation can't reconstruct everything: generics are flattened to
observed unions, mixed-type union arithmetic can produce TS errors, and large
suites can hit an observation-cost wall. The full list — with examples and
workarounds — is in
[What it cannot infer](docs/explanation/what-it-cannot-infer.md).

Always preview with `apply --dry-run`. The
[`ts-capture-apply-review`](./packages/skills/ts-capture-apply-review/SKILL.md)
skill flags risky patterns at apply time.

## Development (this repo is a pnpm monorepo)

```sh
pnpm install
pnpm -r build
pnpm -r test
```

## Writing issues, bugs, and feature requests

ts-capture's domain is TypeScript in → TypeScript out, so we anchor
every issue to a code example. Use tagged code blocks:
` ```ts title="Input" `, ` ```ts title="Expected" `,
` ```ts title="Current" ` (for bug reports). RFCs may use
` ```ts title="Sketch" `.

## License

[MIT](LICENSE)
