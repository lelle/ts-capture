# Contributing to ts-capture

Thanks for your interest! ts-capture is a hobby/research project under
best-effort maintenance — issues and PRs are welcome, but response times
vary and not every request will be taken on.

## Ground rules

ts-capture's domain is **TypeScript in → TypeScript out**. Two conventions
flow from that and are non-negotiable in contributions:

1. **Code-first.** Every bug report, feature request, and behavioural doc
   includes at least one tagged code example. Prose-only claims about a
   transformation are not enough.
2. **Test-driven.** Behaviour is proven by tests, not asserted in prose.
   New behaviour starts with a failing test (Red → Green → Refactor).

Code comments say only what the code cannot: a constraint or a non-obvious
why, usually one to three lines. The history behind a change belongs in its
commit body and changeset. Say a thing once, where the decision is made; a
test's name and assertions carry the rest. Tighten existing comments in files
you touch.

## Development setup

This is a [pnpm](https://pnpm.io) workspace. Development needs Node.js >= 22.13;
the published packages support Node.js 20 and later, and CI tests them there.

```sh
pnpm install
pnpm -r build      # compile every package to dist/
pnpm -r test       # run the suites
```

Useful checks (CI runs all of these):

```sh
pnpm format:check  # prettier
pnpm lint          # oxlint / eslint
pnpm typecheck     # tsc --noEmit, incl. *.spec.ts
pnpm verify        # full local CI parity (scripts/ci.sh)
```

A husky pre-commit hook runs prettier, lint, and typecheck.

## Making a change

1. **Branch** off `main`.
2. **Write a failing test first**, then make it pass, then refactor. See a
   sibling `*.spec.ts` for the test style of the package you're touching.
3. **Document transformations with tagged blocks** where relevant:

   ````markdown
   ```ts title="Input"
   function greet(name) { ... }
   ```

   ```ts title="Expected"
   function greet(name: string): string { ... }
   ```
   ````

   Recognised titles: `Input`, `Expected`, `Current` (bug reports),
   `Repro` (standalone reproducer), `Sketch` (RFC design sketches).

4. **Add a changeset** describing the user-visible change:

   ```sh
   pnpm changeset
   ```

   Pick the affected packages and a bump type (`patch` / `minor` /
   `major`), and write two to four sentences on what changed for the user.
   Commit the generated `.changeset/*.md` file with your change. Changes with
   no user-visible effect (internal refactors, tests, docs) don't need one.

5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org):
   `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, with a short
   body giving the why.
6. **Open a PR.** CI must be green: format, lint, build, typecheck, tests.

## How releases work

Maintainers don't publish by hand. When changesets land on `main`, the
**Release** workflow opens a "Version Packages" PR that bumps versions and
updates each package's `CHANGELOG.md`. Merging it publishes to npm with
provenance via trusted publishing (OIDC).

## Reporting bugs and proposing features

Use the issue templates — they prompt for the `Input` / `Expected` /
`Repro` blocks the maintainers need to act on a report. Security issues go
through [`SECURITY.md`](./SECURITY.md), not public issues.

By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
