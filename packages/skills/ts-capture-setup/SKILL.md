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
+ import { tsCapturePlugin } from "@ts-capture/vite";
  export default defineConfig({
+   plugins: [tsCapturePlugin()],
    test: {
+     pool: "forks",
+     poolOptions: { forks: { singleFork: true } },
    },
  });
```

Include the `pool: "forks"` + `singleFork: true` recommendation in
the Vitest path — per ts-capture's EVALUATION docs, this is the
cheapest large-effect mitigation for per-fork init overhead on
non-trivial codebases (took the hono suite from "hangs" to 246s).

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
+ tsCapturePlugin({ target: "node" }),
```

For the Babel-plugin path, the planned edits are TWO files:

```
babel.config.js
  module.exports = {
    presets: ["@babel/preset-typescript"],
+   plugins: ["@ts-capture/babel-plugin"],
  };
```

```
test/setup.ts          (or whatever the user's setupFiles points at)
+ import "@ts-capture/babel-plugin/runtime";
```

If the user has no setup file referenced in their Jest config, propose
adding one AND adding it to `setupFiles` — but show both edits in the
same hunk so the change is reviewable as a unit.

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

The packages are published under the `next` dist-tag only (see the
[pre-release notice](https://github.com/lelle/ts-capture#ts-capture)
on the project README) — a plain `npm install @ts-capture/<pkg>` will
not resolve, so the `@next` suffix is required:

```sh
npm install --save-dev @ts-capture/core@next @ts-capture/<adapter>@next
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
ts-capture merge ./.ts-capture --out types.json
ts-capture apply types.json --dry-run   # preview before writing
```

If `ls .ts-capture/` is empty after the test run, that's the failure
mode this skill exists to catch — walk back through Step 2's adapter
choice and Step 3's edits. Common causes:

- Vitest `pool: "threads"` + short workers: workers exit before the
  observation flush ticker fires. Fix is `pool: "forks", singleFork: true`
  (already in the planned Vitest edits) — verify the user didn't edit
  it back.
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
  - Cleaner output for already-typed varDecls →
    `infer.skipInferableVarDecls: true`
  - State-machine code with stable string enums →
    `infer.literal.string: true`

Default `ts-capture.config.json` (only if asked):

```json
{
  "infer": {
    "skipInferableVarDecls": true
  }
}
```

Don't propose flag-setting that requires runtime cooperation (e.g.,
`rewriteCommonBase`) without ALSO showing the corresponding
adapter-side edit (vite plugin opts or env var).

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

- Does not run `npm install` for the user.
- Does not run the user's test suite.
- Does not validate the user's `tsconfig.json` is internally consistent
  — that's TypeScript's job and any error will surface on the first
  ts-capture run anyway.
- Does not migrate from a different type-inference tool (typewiz,
  TypeStat) — those have different config schemas and migration
  belongs in a separate skill if it ever matters.
- Pre-release: packages ship under the `next` dist-tag only, so install
  commands need the `@next` suffix. Once a stable release lands on
  `latest`, they switch to the plain
  `npm install --save-dev @ts-capture/...` form. Until then, set
  expectations honestly.
