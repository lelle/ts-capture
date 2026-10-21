# Review & apply safely

Goal: run `apply` on a real, existing codebase with confidence. ts-capture is
conservative by default, but on production code a few habits keep the diff
clean and reviewable.

## Commit before you apply

`ts-capture apply` **writes into your source files**. Before you run it, make
sure the project is under source control and the working tree is clean:

```sh
git status --porcelain   # expect no output — nothing uncommitted
```

This single habit is what makes everything else safe:

- **Review** — `git diff` after apply shows exactly what ts-capture changed,
  and nothing else.
- **Undo** — `git checkout .` (or `git restore .`) reverts the whole run.
- **Bisect** — landing the apply as its own commit keeps it separable from
  hand-written changes if a type turns out to be wrong later.

If you can't start from a clean tree, at least commit or stash your own work
first, so the apply diff isn't tangled up with it. The same applies to the
other paths that touch disk: `ts-capture instrument --in-place` and
`@ts-capture/core/register` rewrite source files too — and `register` does it
on process exit with no `--dry-run` preview at all.

The collected dumps and `types.json` are working files, not source — keep
`.ts-capture/`, `types.json` and `types.json.applied` out of the commit
(the [tutorial](../tutorials/getting-started.md) has the `.gitignore` block).

## Don't edit source between observe and apply

Observations carry **byte offsets** into the source as it was when the run
happened. Editing a file between the test run and `apply` shifts those offsets.

ts-capture won't corrupt the file — it checks that the recorded position still
looks like a valid insertion site — but that guard is a heuristic and **fails
quietly**: the annotation is dropped, not reported. A run that writes far fewer
types than the dry-run promised usually means the source moved underneath it.

The reliable order is: observe → merge → apply, with no edits in between. If you
did edit, re-run observation rather than trusting the old `types.json`. The same
applies after `instrument --in-place`: restore those files (`git checkout`)
before applying, so offsets match the original source rather than the
instrumented copy.

## Always dry-run first

```sh
npx ts-capture apply types.json --dry-run
```

`--dry-run` reports what _would_ change without writing anything. Read the
preview as you would a PR diff before committing to it.

## Or preview in the editor

`--dry-run` puts the diff in your terminal. On a large run the more useful
question is often "is _this_ type right, here, next to the code it describes" —
and for that the proposal wants to be in the file:

```sh
npx ts-capture apply types.json --comments
```

Nothing is annotated. Each site that would have been gets a note saying what
apply would write, how much of it the run saw, and what TypeScript already had:

```ts
// @ts-capture[proposal]: `args` would be `number[]`
// @ts-capture:   observed 374 times; TypeScript infers `any`
const args = Reflect.getOwnMetadata(OPTIONAL_DEPS_METADATA, target) || [];
```

Read them, decide, and then run apply for real. **The notes clean themselves
up**: apply owns every line carrying the marker and removes the ones it finds
before writing anything, so the ordinary run that follows leaves the file with
annotations and no scaffolding.

A note only appears where an annotation would actually land — candidates the
type-check gate rejects are not proposed, because a proposal you cannot take is
not a proposal.

`--both` writes the annotation _and_ the note, for reading an applied diff with
the reasoning beside the result. Both flags are shorthand for
`--infer.outputMode`, which the [reference](../reference/configuration.md#notes)
describes in full.

`observed once` is worth a pause, not a veto. It means the code ran that path
once, which is as often true of a config object read at startup — a perfectly
stable shape — as of one caller's incidental payload. The number cannot tell
those apart; looking at where the value comes from can.

## What `apply` will and won't do

- **Won't overwrite existing annotations** — only positions with no written
  type are filled. An explicit `: any` is a written type and is left alone.
- **Won't introduce type errors** — every candidate is checked against the
  project's TypeChecker (`infer.typecheckVerify`, on by default) and dropped if
  it would add a diagnostic.
- **Skips test files** (`*.spec.*`, `*.test.*`) unless you pass
  `--include-tests`.
- **Is idempotent** — a `<types.json>.applied` manifest records what was
  written; re-running is a no-op. Use `--force` to bypass the manifest.

## What is still untyped afterwards

A strict project that had implicit-`any` errors before `apply` usually still
has some after it. That is the expected result, not a failed run. Three things
leave a position alone:

- **Nothing ran it.** Only values that passed through the code during the test
  run are observed. A function no test calls keeps its `any`.
- **It is in a test file.** `*.spec.*` and `*.test.*` are skipped unless you
  pass `--include-tests`, so their errors stay.
- **It was observed and not written.** The type would add a type error
  somewhere in the project, or the observation carried nothing to write.

Every run ends by counting the third kind:

```text title="Current"
apply: 40 annotations written in 6 files.
       12 observed positions not written (6 would add a type error, 6 with no type information) - see --report.
```

`--report` lists each of them with its reason, and works with `--dry-run`:

```sh
npx ts-capture apply types.json --dry-run --report
```

Read the report before reading compiler errors: an error at a position the
report names has its cause there. What is left is yours to type by hand — see
[What it cannot infer](../explanation/what-it-cannot-infer.md).

## Skip files you don't want touched

Add gitignore-style globs under `apply.skipFiles` in `ts-capture.config.json`.
They stack on top of the built-in test-file default; last match wins, and a
leading `!` re-includes:

```json title="ts-capture.config.json"
{
  "apply": {
    "skipFiles": ["src/**/*.{gen,generated}.ts", "!src/generated/keep.ts"]
  }
}
```

## Watch for these in review

- **Over-narrow types** — a single test run may show `string` where the real
  contract is `string | URL`. Public API surfaces especially warrant a closer
  look.
- **Flattened unions** — `(x: string | number)` where a generic `<T>(x: T)`
  was meant ([why](../explanation/what-it-cannot-infer.md#generics-are-flattened-to-observed-unions)).
- **Huge annotations** — logger/serializer functions passed whole app state can
  produce enormous types. `infer.maxAnnotationChars` (default 4096) suppresses
  these so TS inference takes over instead; tune it if needed.
- **Real data in literal types** — see
  [Observed values in your output](#observed-values-in-your-output) below.
- **Under-observed positions** — a type reflects the run you did, not the
  contract. Types that came from a narrow test selection deserve more suspicion
  than types from a full suite.

For agent-assisted review of these cases, see the
[`ts-capture-apply-review`](../../packages/skills/ts-capture-apply-review/SKILL.md)
skill.

## Observed values in your output

Even with everything at defaults, a dump describes your codebase: the
source-file paths the bundler saw (usually absolute), parameter names and
offsets, and type shapes down to your objects' property key names. That is why
dumps belong in `.gitignore` and deserve deletion when you're done.

Beyond that, ts-capture emits **types, not values**: an observed `"sk-live-42"`
becomes `string`. Two opt-in features change that, and both mean production-ish
data can end up in places you didn't intend:

- `infer.literal.string` / `.number` / `.boolean` write the observed literal
  into the annotation itself (strings up to `infer.literal.stringMaxLength` —
  enough for a token prefix, a short key or a name).
- The collected dumps and `types.json` hold the same literals, and they are
  ordinary files in your working directory.

If your tests run against real data — recorded fixtures, a shared staging
database, production snapshots — review literal annotations specifically before
committing, and treat `types.json` as data rather than as build output.

## Notes ts-capture leaves behind

Besides annotations, apply writes comments — a `[conflict]` where the run
observed a value the position's own type forbids, and `[proposal]` /
`[applied]` in the preview modes above. The reference has
[the formats](../reference/configuration.md#notes).

Apply rewrites every `@ts-capture[…]:` note on each run, one you typed
yourself too; `@ts-capture-ignore` it leaves alone
([why](../reference/configuration.md#apply-owns-every-note)).

## After apply: format and type-check

Save your editor buffers first — `apply` writes files underneath a running
editor, and an unsaved buffer written afterwards silently reverts it. Then
finish with your own toolchain, since `apply` runs neither your formatter (a
long structural type lands as one over-long line, failing `prettier --check`
in CI) nor a full build:

```sh
npx prettier --write .    # or your formatter
npx tsc --noEmit          # the whole project, not just the touched files
npm test
```

The `infer.typecheckVerify` gate drops candidates that would introduce a
diagnostic, but it evaluates the target file and its importers — a full
`tsc --noEmit` is still the check that tells you the project builds.

## Tuning

Most of the above is configurable — literal types, pattern detection, the
type-check gate, and more. See the
[Configuration reference](../reference/configuration.md).
