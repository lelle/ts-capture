---
name: ts-capture-setup
description: Set up ts-capture in an existing TypeScript project — detect the test runner and build stack, recommend the right `@ts-capture/*` adapter package, write the config edits, install the deps. Use when the user asks to "install ts-capture", "add ts-capture to my project", "set up ts-capture for vitest/jest/etc", "what ts-capture packages do I need", or "how do I get started with ts-capture". Also triggers when ts-capture is mentioned alongside a fresh project setup or a "ts-capture doesn't work" / "ts-capture isn't observing anything" complaint that turns out to be missing wiring. Hand off to `ts-capture-apply-review` once the user has a `types.json` to apply.
---

# TsCapture setup

Onboarding-friction skill. The ts-capture engine is small but the wiring
is **stack-specific** — wrong adapter package or a misplaced config
hook means the user runs their tests, finds zero observations, and
quits before they've seen what ts-capture can do. Detection should be
deterministic, recommendations should be confident, and config edits
should be diffed before they land.

## When to apply

Strong signals:

- "Set up ts-capture for my [vitest/jest/mocha] project."
- "What ts-capture packages do I need?"
- "How do I install ts-capture?"
- "I added ts-capture but no observations are showing up."
- The user has run `npm test` with ts-capture loaded and gotten an empty
  `types.json` — usually a wiring bug, not a coverage one.

Less direct:

- The user is starting a fresh TS migration and mentions ts-capture.
- The user pastes a `package.json` and asks how to add ts-capture.

## When NOT to apply

- The user already has a working setup and is asking about something
  else (apply review, performance, output noise) — route to the right
  skill instead.
- The user is debugging ts-capture itself (missing instrumentation in
  core, transformer crash, etc.) — point to the project's GitHub Issues
  rather than treating it as a setup issue.

## Workflow

### Step 1 — Read the project state, don't guess

Required reads (in this order):

1. `package.json` — `devDependencies`, `dependencies`, `scripts`.
   Note the **vitest major** if present: the options for running in
   one process differ between Vitest 3 and 4, and the wrong form is
   ignored rather than rejected (Step 3).
2. `tsconfig.json` (and any `tsconfig.*.json`) — `module`,
   `moduleResolution`, `strict`, `experimentalDecorators`,
   `lib` includes.
3. The build/test config that the package.json points at:
   - `vite.config.{ts,js,mjs}`, `vitest.config.{ts,js,mjs}` if Vite/Vitest
   - `jest.config.{ts,js,mjs,json}` or the `"jest"` key in package.json if Jest
   - `babel.config.{js,json}` or `.babelrc` if Babel is in the chain
   - `mocharc.{js,json,yml}` if Mocha
4. Whether `node_modules/@ts-capture/*` already exists (idempotency —
   the user may have started setup already).

If a config file is referenced in `package.json` scripts but doesn't
exist on disk, ask before guessing — projects sometimes use non-default
paths.

### Step 2 — Pick the adapter from the detected stack

Use this matrix. Where multiple paths are possible, pick the FIRST
matching row top-to-bottom — the upstream tool determines the answer
even if a runner sits in front.

| Detected stack                                             | Adapter                                   | Why                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Svelte 5 + Vitest (SvelteKit or standalone)                | `@ts-capture/svelte` + `@ts-capture/vite` | Add `sveltePreprocessor()` to `vite.config.ts` plugins before the Svelte plugin; it instruments `<script>` blocks. For `$state` runes, also import `attachPeek` from `@ts-capture/svelte/runes`. Use `applySvelteTypesToFile` (from `@ts-capture/svelte/apply`) instead of `applyTypesToFile` for `.svelte` files — it remaps byte offsets from block-relative to file-relative automatically. |
| Vitest (any pool) OR Vite                                  | `@ts-capture/vite`                        | Vitest goes through Vite's transform pipeline; one plugin covers both bundler and runner.                                                                                                                                                                                                                                                                                                      |
| Jest with `@babel/preset-typescript` (no ts-jest)          | `@ts-capture/babel-plugin`                | Babel is already in the chain; plugin slots in cleanly. Mirrors the istanbul/babel-plugin-istanbul pattern.                                                                                                                                                                                                                                                                                    |
| Jest with ts-jest or @swc/jest + `testEnvironment: 'node'` | `@ts-capture/core/preload`                | No Babel hook; NODE_OPTIONS preload works because the node test env shares Node's `globalThis`.                                                                                                                                                                                                                                                                                                |
| Jest with ts-jest or @swc/jest + jsdom env                 | `@ts-capture/core/setup`                  | jsdom env wraps each test file in a fresh vm context; Node globals don't leak in. Import the setup module via `setupFilesAfterEnv` to install `__tscptr__` inside the sandbox.                                                                                                                                                                                                                 |
| Mocha + ts-node                                            | `@ts-capture/core/preload`                | ts-node loader runs before any user-space hook. NODE_OPTIONS preload is the only point of attachment. Verify `ts-node/register` isn't double-loaded.                                                                                                                                                                                                                                           |
| AVA / Tap / node:test (plain TS via tsx, swc, etc.)        | `@ts-capture/core/preload`                | Same reason: the loader chain runs first, NODE_OPTIONS preload is the cleanest hook.                                                                                                                                                                                                                                                                                                           |
| Bun test                                                   | `@ts-capture/core/preload` (best-effort)  | Bun's test runner is not a first-class target. The runtime shim works in Node-compat paths; warn the user this is best-effort and may need manual smoke-testing.                                                                                                                                                                                                                               |
| No test runner — dev server only (Vite)                    | `@ts-capture/vite`                        | Use the dev-server beacon path with `outputFile`. Make sure the user knows beacons fire only in `vite serve`, not `vite build` / Vitest.                                                                                                                                                                                                                                                       |
| No build tool, plain `node script.ts`                      | `@ts-capture/core/preload`                | NODE_OPTIONS preload covers this directly.                                                                                                                                                                                                                                                                                                                                                     |

**Where observations land — and why browser mode is different.**

Every row above delivers the same way: per-process JSON dumps under
`TS_CAPTURE_TYPES_DIR`, consolidated with `ts-capture merge`. Vitest
**browser mode** (`test.browser.enabled`, e.g. the Playwright provider)
does not — and it fails silently, which makes it the single most likely
cause of a "the tests pass but there are no dumps" report on a modern
Svelte / Vue / React project.

A browser has no filesystem to dump to. The collector POSTs to the
plugin's `/__ts-capture_collect` middleware instead, and that middleware
**discards what it receives unless `outputFile` is set**. So
`TS_CAPTURE_TYPES_DIR` has no effect there, `ls` finds nothing, and
nothing warns:

```
src/vite.config.ts
+ tsCapture({ outputFile: "./ts-capture-browser.json" }),
```

Merge that file instead of a dump directory — or alongside one, since a
project with both a node and a browser test project (a SvelteKit scaffold
is exactly this) needs the plugin in both:

```sh
npx ts-capture merge ./ts-capture-browser.json --out types.json
npx ts-capture merge ./.ts-capture ./ts-capture-browser.json --out types.json
```

Delivery is scheduled as observations arrive. On builds predating that,
the browser collector only flushed on a 10-second ticker and on
`beforeunload` — neither of which a test-runner page reaches — so a run
shorter than ten seconds delivered nothing at all. If a browser-mode run
produces an empty `outputFile`, check the installed version before
re-reading the config.

Edge cases that need a question, not a guess:

- **Both Vitest and Jest** — monorepo with mixed runners. Ask which
  package(s) the user wants to instrument and pick per-package, not a
  single global decision.
- **`type: "module"` in package.json + Jest** — Jest's ESM support is
  experimental. Babel-plugin path works; ts-jest path may need
  `--experimental-vm-modules`. Surface the caveat.
- **`experimentalDecorators: true` in tsconfig** — should still work,
  but flag that ts-capture has not been validated against
  decorator-heavy codebases (NestJS, Angular, TypeORM); apply review
  matters more here.

### Step 3 — Show the planned edits BEFORE making them

For each config file you're about to touch, present a single diff
hunk. Format:

```
src/vite.config.ts
+ import tsCapture from "@ts-capture/vite";
  export default defineConfig({
+   plugins: [tsCapture()],
  });
```

Leave the worker settings alone. Vitest starts a process per test
file by default, each writes a dump of its own, and `merge` puts them
together; on a small or medium suite nothing needs changing.

Only if the instrumented run is much slower than the plain one, or
hangs — each process sets the plugin pipeline up again, and on a suite
with hundreds of files that adds up (it took the hono suite from
"hangs" to 246s) — propose running it in one process for the
observation run. **Which options do that depends on the vitest major
read in Step 1:**

| Vitest | Options                                                          |
| ------ | ---------------------------------------------------------------- |
| 4+     | `fileParallelism: false` and `isolate: false` (under `test`)     |
| 3      | `pool: "forks"` + `poolOptions: { forks: { singleFork: true } }` |

On Vitest 4+ it takes both. `fileParallelism: false` alone runs the
files one after another and still starts a process for each: measured
on Vitest 5 with six test files, six processes and twice the run time
of the default, against one process and half the time with
`isolate: false` beside it. Say what `isolate: false` costs before
proposing it: test files then share module state, and a suite that
relies on a fresh module per file can fail. It is for the observation
run; take it out again afterwards.

Vitest 4 removed `poolOptions`; every pool option moved to the top
level. The Vitest 3 form in a Vitest 4 config prints a deprecation
warning and is otherwise ignored. The Vitest 4 form in a Vitest 3 config
is ignored _silently_ — the worse of the two, and indistinguishable from
the wiring failures this skill exists to catch. Read the version.

If the user's Vitest config has `environment: "jsdom"` (or
`"happy-dom"`) — common in SvelteKit, Vue, and React-Testing-Library
projects — the auto-detect since 2026-05-10 already routes the
collector to the Node file-dump path. No extra config needed. If
the user reports "tests run but `npx ts-capture merge` finds no
dumps" on a non-jsdom but unusual runtime (Deno, Bun, custom
worker), surface the explicit `target: "node"` plugin option as
the escape hatch:

```
src/vite.config.ts
+ tsCapture({ target: "node" }),
```

For the Babel-plugin path, the planned edits are TWO files:

```
babel.config.js
  module.exports = {
    presets: [ ...the user's presets, unchanged... ],
+   plugins: ["@ts-capture/babel-plugin"],
  };
```

```
jest.config.js
  module.exports = {
+   setupFiles: ["@ts-capture/babel-plugin/runtime"],
  };
```

Add the `plugins` line and leave the presets alone. Jest needs the
ones it has; a config cut down to `@babel/preset-typescript` fails
every suite with "Must use import to load ES Module", with or without
ts-capture.

If the Jest config already lists a setup file in `setupFiles`, the
import can go at the top of that file instead
(`import "@ts-capture/babel-plugin/runtime";`). One or the other must
be there: without it the suite passes and no dump is written.

For the runtime path, the planned edit is the test script:

```
package.json
  "scripts": {
-   "test": "vitest run"
+   "test": "NODE_OPTIONS='--require @ts-capture/core/preload' vitest run"
  }
```

Or `cross-env NODE_OPTIONS=...` if the user is on Windows or has
`cross-env` already installed.

After showing the edits, ask: **"Apply these?"** Don't run the edits
without confirmation — config files are user-owned territory and a
silent injection is worse than a missed convenience.

### Step 4 — Install the deps (with confirmation)

The packages are 0.x pre-releases (see the
[pre-release notice](https://github.com/lelle/ts-capture#ts-capture)
on the project README); the API may change between minor versions:

```sh
npm install --save-dev @ts-capture/core @ts-capture/<adapter>
# Or, from a local clone of the monorepo:
# npm install --save-dev /path/to/ts-capture/packages/core /path/to/ts-capture/packages/<adapter>
```

Show the exact command and let the user run it. Don't shell out to
`npm install` from the skill — the user may have package-manager
preferences (pnpm, yarn, bun) and project-specific install policies.

If `node_modules/@ts-capture/*` is already present (idempotent re-run),
skip the install step and just verify versions match what the planned
config edits expect.

### Step 5 — Smoke-test and hand off

After the edits land and deps are installed, the user's first run
should produce dump files. Suggest:

```sh
TS_CAPTURE_TYPES_DIR=./.ts-capture npm test
ls .ts-capture/                    # expect one or more ts-capture-types-*.json
npx ts-capture merge ./.ts-capture --out types.json
npx ts-capture apply types.json --dry-run   # preview before writing
```

Under Vitest browser mode the first two lines don't apply — check the
`outputFile` you configured in Step 2 instead:

```sh
npm test
ls -l ./ts-capture-browser.json    # expect a non-empty JSON array
npx ts-capture merge ./ts-capture-browser.json --out types.json
```

If `ls .ts-capture/` is empty after the test run, that's the failure
mode this skill exists to catch — walk back through Step 2's adapter
choice and Step 3's edits. Common causes:

- Vitest browser mode: `TS_CAPTURE_TYPES_DIR` does not apply there. The
  collector POSTs to the dev-server middleware, which drops the payload
  unless `outputFile` is set. Check `test.browser.enabled` before
  re-litigating the adapter choice — the adapter is right, the delivery
  channel is the one that changed.
- Vitest `pool: "threads"` + short workers: workers exit before the
  observation flush ticker fires. Fix is running the observation in
  one process, with the options for the user's vitest major (Step 3).
- Babel-plugin path: the runtime import in the setup file was
  forgotten or the setupFiles entry doesn't reference the right path.
- Runtime-shim path: `NODE_OPTIONS` was overridden by another script
  layer (e.g., a wrapper that resets env). Check the test script
  invocation chain.

After the user has a `types.json` and is ready to apply, hand off to
the [ts-capture-apply-review](../ts-capture-apply-review/SKILL.md) skill —
its judgment layer is most useful at the apply-review step, not at
setup.

Say this explicitly at handoff: **`ts-capture apply` rewrites source files,
so the project must be under source control with the working tree committed
before the first apply.** That's what makes the run reviewable as a
`git diff` and revertible with `git checkout .`.

### Step 6 — Optional: scaffold `ts-capture.config.json`

Most projects don't need this. Only suggest it if:

- The user explicitly asks about config tuning.
- The user's stack hits one of the documented opt-in scenarios:
  - Class hierarchies → `infer.rewriteCommonBase: true` (requires
    runtime `LiteralOptions.captureClassHierarchy: true` paired in the
    adapter config)
  - State-machine code with stable string enums →
    `infer.literal.string: true`
  - A measurement run that wants to see every annotation ts-capture would
    write, including the ones TypeScript already infers →
    `infer.skipRedundantAnnotations: false` (on a `const` these are lossy,
    not merely redundant — do not suggest it for a real rewrite)

`ts-capture.config.json` is only worth writing when one of those applies; the
defaults are what a normal run should use. Shape:

```json
{
  "infer": {
    "literal": { "string": true }
  }
}
```

Don't propose flag-setting that requires runtime cooperation (e.g.,
`rewriteCommonBase`) without ALSO showing the corresponding
adapter-side edit (vite plugin opts or env var).

## When you were asked to do it yourself

Steps 3 and 4 assume a user who reads each edit and runs each command.
When the user has instead asked you to set ts-capture up — "adopt it in
this project", with nobody to answer "Apply these?" — the confirmations
are already given. Make the config edits and run the install, with the
project's own package manager.

What does not change:

- Read the project first (Step 1). Delegation is not a reason to guess.
- Commit the wiring before any `apply`, so the annotations are a diff
  of their own.
- Run the smoke test in Step 5 and read its output yourself.
- Report what you did: each file edited, each command run, and
  anything you chose between.

## Tone

Direct and decision-shaped. "You have Vitest, so you want
`@ts-capture/vite` — here's the edit" is more useful than "There are
several options depending on your stack…". Surface the assessment
first, then the supporting evidence (which file you read to
determine it).

When the stack is genuinely ambiguous (monorepo with multiple
runners, custom build pipeline, unfamiliar tool), say so and ask one
specific clarifying question — don't guess and proceed.

## Limitations

- Does not run `npm install` for the user, or the user's test suite,
  unless it was asked to do the work itself.
- Does not validate the user's `tsconfig.json` is internally consistent
  — that's TypeScript's job and any error will surface on the first
  ts-capture run anyway.
- Does not migrate from a different type-inference tool (typewiz,
  TypeStat) — those have different config schemas and migration
  belongs in a separate skill if it ever matters.
- Pre-release: the packages are 0.x and the API may change between
  minor versions. Set expectations honestly.
