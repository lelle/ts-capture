<!--
ts-capture is TypeScript in → TypeScript out, developed test-first.
Keep this PR focused; describe the user-visible change, not the diff.
-->

## What & why

<!-- One or two sentences: what this achieves and why. -->

## Behaviour

<!-- For a transformation change, show it with tagged code blocks. -->

```ts title="Input"

```

```ts title="Expected"

```

## Checklist

- [ ] Tests added/updated first (Red → Green → Refactor); `pnpm -r test` is green.
- [ ] `pnpm format:check`, `pnpm lint`, and `pnpm typecheck` pass.
- [ ] Added a changeset (`pnpm changeset`) for any user-visible change — or this change has none.
- [ ] Conventional Commit title (`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`).
- [ ] Docs touched where behaviour changed (tagged `Input` / `Expected` blocks).
