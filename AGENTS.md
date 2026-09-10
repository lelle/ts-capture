# Agent guidelines

Read [CONTRIBUTING.md](./CONTRIBUTING.md) first; it is the source for setup, TDD, changesets and commits. In addition:

- Run `pnpm verify --skip-install` before calling a change done. A package's own `lint` is only oxlint; the ESLint rules run from the repo root (`pnpm lint`).
- Comments: only what the code cannot say, usually one to three lines. History and measurements go in the commit body and changeset. Say a thing once.
- Commits: a Conventional Commit subject plus a short body giving the why. No AI attribution or session trailers.
- Changesets: two to four sentences on what changed for the user.
