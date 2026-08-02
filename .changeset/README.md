# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
Each change that should ship in a release adds a markdown file here describing
the bump (`major` / `minor` / `patch`) for each affected package, plus a
human-readable summary.

## Adding a changeset

```sh
pnpm changeset
```

Pick the affected packages, the bump type, and write a one-line summary
(this becomes the CHANGELOG entry). Commit the generated file alongside
your change so it goes through review.

## How a release happens

1. PRs land on `main`, each carrying its own changeset file.
2. The **Release** workflow opens (and keeps updating) a "Version Packages"
   PR that consumes the pending changesets, bumps versions, and writes each
   package's `CHANGELOG.md`.
3. Merging that PR publishes the bumped packages to npm with provenance via
   trusted publishing (OIDC) — no npm token required.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full flow.
