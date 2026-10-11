---
name: ts-capture-apply-review
description: Review the output of `ts-capture apply --dry-run` (or a post-apply git diff) and flag annotations that look risky — mixed-union arithmetic conflicts, likely-generic functions flattened to unions, verbose structural types matching well-known built-ins, and other judgment calls that runtime observation can't make on its own. Use when the user has run `ts-capture apply` (or is about to) and wants a second pair of eyes on the diff, asks "are these ts-capture annotations safe", mentions reviewing a ts-capture change before commit, or has ts-capture-related TS errors after applying. Also triggers on "ts-capture dry-run review" and "ts-capture annotation regression".
---

# TsCapture apply review

Review the diff produced by `ts-capture apply --dry-run` (or a post-apply
`git diff` if apply already ran) and identify annotations that the
ts-capture engine cannot assess from runtime observations alone.

Runtime observation alone can produce technically-correct annotations
that are nevertheless wrong _for the program's intent_: a generic
flattened to a union, an arithmetic operator stranded across a
`string | number`, a verbose structural type where a built-in would
read better. Heuristic detection of these patterns produces too many
false positives to live in the engine. Judgment, with the source code
in hand, lives well in an LLM.

## When to apply

The strongest signals:

- The user has run `ts-capture apply --dry-run` and is deciding whether
  to apply for real.
- `tsc --noEmit` reports errors after the user ran `ts-capture apply`.
- The user explicitly asks "is this ts-capture diff safe" or "review
  these ts-capture annotations".
- A ts-capture change is staged and the user wants a sanity pass before
  committing.

Less direct signals:

- The user pastes a diff and mentions ts-capture.
- The user discusses ts-capture on a typed codebase (where regressions
  are most likely) and is about to commit.

## When NOT to apply

- The user wants the raw ts-capture output without judgment ("just run
  apply, don't second-guess it").
- The diff is on a fully untyped or freshly migrated codebase where
  ts-capture's automated baseline is exactly what's wanted (greenfield
  inference, not refinement).
- The user is debugging ts-capture itself, not its output. Engine bugs
  belong in the ts-capture repo, not in a per-application review.

## Workflow

### Step 1 — Get the diff

The user will usually provide one of:

- A path to `apply --dry-run` output saved to a file
- A path to types.json + the source files (less ideal — needs to run
  apply first)
- A git diff in chat (paste-mode)
- An open repo with `git status` showing the uncommitted apply diff

If unclear, ask: "Should I review the staged changes in this repo
(`git diff`), or do you have a `--dry-run` output I should read?" Don't
guess.

If the user has not yet run `apply --dry-run` and there's no diff to
review, suggest:

```sh
npx ts-capture apply types.json --dry-run > apply-preview.txt
# then re-run the review with the saved file
```

Do not run `apply` (without `--dry-run`) on the user's behalf.

If the user has NOT applied yet, check `git status --porcelain` first. `apply`
rewrites source files in place, so unrelated uncommitted edits get tangled with
the ts-capture diff and can't be reverted independently — say so and let them
commit or stash. Don't run this check when reviewing an apply that already
happened: an uncommitted tree is exactly what you're there to read.

### Step 2 — Classify each changed declaration

Read the diff hunk-by-hunk. For each annotation ts-capture would write,
classify into one of:

| Class          | Treatment                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Safe**       | Inner-position fills (`(name: string)` on a previously untyped param) on non-test code where the observed type matches the body's usage. No comment needed unless the user asked for full output. |
| **Suspicious** | Annotations that compile but encode a guess that may not be the user's intent. Flag with reasoning.                                                                                               |
| **Broken**     | Annotations that won't typecheck or contradict surrounding code. Flag urgently with a fix suggestion.                                                                                             |

### Step 3 — Watch for these specific patterns

These are the patterns runtime observation reliably gets wrong. The
ts-capture engine deliberately doesn't try to catch them — that's why
this skill exists.

#### 3a — Mixed-union arithmetic

Pattern: a function param annotated with a union (e.g.,
`string | number`) AND the body contains an arithmetic, comparison, or
string-coercion operator on those params.

```ts
// TsCapture wrote:
const noTypes = (a: string | number, b: string | number): string | number =>
  a + b;
// `+` on `string | number` is TS2365 — JS allows it, TS doesn't.
```

Suggested fix patterns (pick the one matching the user's intent):

- **Two overloads** if the function genuinely supports both:
  ```ts
  function noTypes(a: string, b: string): string;
  function noTypes(a: number, b: number): number;
  function noTypes(a: any, b: any): any {
    return a + b;
  }
  ```
- **Pick one** if the test ran with both kinds but production uses only
  one. Look at the test file vs. production callers.
- **Generic with constraint** for some idioms:
  `<T extends string | number>(a: T, b: T): T`. Caveat: `+` still
  errors; useful when narrowing happens elsewhere.

Read the body to decide which fix fits. If unclear, present the
options and let the user choose.

#### 3b — Likely-generic functions

Pattern: function param type and return type are identical unions of
≥2 distinct types, and the body trivially returns the input (or an
element of it).

```ts
// TsCapture wrote:
function identity(
  x: number | string | { a: number },
): number | string | { a: number } {
  return x;
}
// User probably meant: <T>(x: T): T
```

Variants to recognise:

- `<T>(x: T): T` — identity-shaped
- `<T>(arr: T[]): T` — element-extraction (param is `T1[] | T2[]`,
  return is `T1 | T2`)
- `<T, K extends keyof T>(obj: T, key: K): T[K]` — keyof-K (rarely
  detectable from observation alone, but worth flagging if the body
  does `obj[key]`)
- `<T>(x: T): T[]` — wrapper-shaped

Do NOT suggest a generic if:

- The body uses methods/operators that constrain the type (e.g.,
  `x.toUpperCase()` — only valid on string; not generic).
- The function is called in a way that benefits from the explicit
  union (rare, but ask the user).
- There's a name collision risk with an existing `T` in scope.

#### 3c — Verbose structural types matching built-ins

Pattern: an object/array type written out structurally that's a
well-known built-in's exact shape.

| TsCapture wrote                                     | Likely meant                                 |
| --------------------------------------------------- | -------------------------------------------- |
| `Array<string \| undefined> \| null \| string[]`    | `RegExpMatchArray \| null`                   |
| `{ then: ..., catch: ..., finally: ... }`           | `Promise<T>` (look up T from observed value) |
| `{ name: string, message: string, stack?: string }` | `Error`                                      |
| `{ done: boolean, value: T }`                       | `IteratorResult<T>`                          |
| `{ size: number, get, set, has, ... }`              | `Map<K, V>`                                  |
| `{ ok: boolean, status: number, headers, ... }`     | `Response`                                   |

When you spot one, suggest the named built-in and check whether the
user's `tsconfig.json` has `lib` includes that match (most modern TS
configs have `dom` and `es202x` — usually fine).

#### 3d — Object literal types that match an imported interface

Pattern: an object literal annotation in the diff that looks like an
existing interface in the same file (or imported).

```ts
// In src/types.ts:
export interface User { id: number; name: string; admin: boolean; }

// TsCapture wrote in src/lib/fetchUser.ts:
function fetchUser(id: number): Promise<{ admin: boolean, id: number, name: string }> { ... }
// User probably meant: Promise<User>
```

Check the file's imports and the rest of the file for matching
interfaces. If found, suggest the named type — improves readability
and binds future type changes through the interface.

#### 3e — Test-runner-specific types

Defensive: ts-capture now defaults to skipping test files, but if the
user passed `--include-tests`, watch for:

- `(): Assertion => ...` on `it()` callbacks — vitest's expect-chain
  return type leaking into the callback signature. Almost never wanted.
- `Mock<...>` annotations on values that are vitest mocks — usually
  fine but verbose; check if `vi.fn()` returns are being captured at
  rest.

#### 3f — Annotations on never-imported code

If the diff annotates a function that's not exported and not imported
anywhere, that function may have been observed via a test and is dead
in production. Flag for the user — they may want to delete the
function rather than annotate it.

#### 3g — Shapes that describe the test data

An object shape is what flowed through the position during the run. Under
a test run that is often a fixture, and nothing flags it: the annotation
compiles and the suite stays green, because it describes exactly what the
suite does. Three marks to look for:

```ts
// Literal keys on a value the code indexes by a variable. `test` and
// `test2` are package names from the project's own test data; the code
// looks up whatever name it is given.
const grpcPkg: { test: { service: boolean }; test2?: { service: boolean } } | null =
  this.lookupPackage(grpcContext, packageName);
// Suggest: Record<string, { service: boolean }> | null

// A required field the function body never reads. The body uses `name`
// and `id`; `email` and `roles` came with the objects the test passed,
// and a caller without them is now rejected.
function labels(users: { email: string; id: number; name: string; roles: string[] }[]) {
  return users.map((user) => `${user.id}: ${user.name}`);
}
// Suggest: users: { email?: string; id: number; name: string; roles?: string[] }[]

// A lookup that can miss, typed as if it always hits. Every test asked
// for something that existed.
find(id: string): { id: string; name: string } {
  return this.users.get(id);
}
// Suggest: { id: string; name: string } | undefined
```

For each object shape in the diff, compare it with what the function
body does with the value, not with what the tests pass. Flag the site
when the two differ, and say which of the three it is.

The second mark is the one that gets left, because nothing about the
annotation looks wrong. Check it site by site: for every parameter typed
as an object, or as an array of objects, list the properties the body
reads and compare with the properties the type requires. A required
property the body never reads is a finding.

Suggest making the property optional (`roles?: string[]`). Do not
suggest removing it. Optional keeps every caller that passes the
property and admits the ones that do not; a type without it rejects a
caller that writes the object in place with the property in it
(`labels([{ id: 1, name: "Ada", roles: [] }])` is an excess-property
error), which is a call the code handled before.

Where the function returns the value or its elements, or stores them,
the body is not the only reader: whoever uses the result reads from the
same shape. Count those reads too, by looking at how the result is used
in the project, and make optional only what neither the body nor any
use of the result reads. When that cannot be settled from the code, flag
the property and leave it required.

`infer.narrowParamShapes` is a different remedy with a cost, not part
of this check. On a re-run it writes a plain object parameter with only
the properties the body reads — it removes the others, so it brings the
excess-property error above, which is why it is off by default. It does
nothing for arrays of objects or for values a function returns or
passes on. Mention it as an option; do not imitate it by hand.

Background: "An object shape describes the values the run saw, not the
contract" in ts-capture's `docs/explanation/what-it-cannot-infer.md`.

### Step 4 — Report

Present findings as a per-site list. Each entry:

```
src/lib/identity.ts:5
- Pattern: likely-generic. Param/return identical union of 3
  unrelated types and body just returns x.
- TsCapture wrote: function identity(x: number | string | { a: number }): number | string | { a: number }
- Suggested:    function identity<T>(x: T): T
- Reason: x is returned unchanged; no body operations constrain T.
- Confidence: high (no string/number-specific methods on x).
```

Order findings by severity:

1. Broken (won't typecheck)
2. Suspicious (typechecks but probably wrong)
3. Notable (typechecks, fine, but worth knowing — e.g., 3c)

If there are no findings to flag, say so explicitly: "Nothing concerning
in this diff — ts-capture's output looks safe to apply." Don't manufacture
nitpicks just to fill space.

Say what is left as well. A strict project usually still fails typecheck
after apply, and that is not a finding against the diff: code the tests never
ran is not observed, test files are skipped by default, and an observation
that would add a type error is not written. Run
`npx ts-capture apply types.json --dry-run --report` and name the positions it
lists before attributing a remaining error to anything else.

### Step 5 — Hand off

Do not edit the user's source files yourself. The point of this skill
is judgment + recommendation; the user decides what to apply. Their
options after the report:

- Run `ts-capture apply` as-is (accept all annotations)
- Run `ts-capture apply` then manually fix the flagged sites
- Skip apply, refine the source manually based on findings

If the user explicitly asks the skill to apply specific suggestions,
that's a different mode — confirm scope per site before editing. If
they asked for the whole adoption to be carried through, see "When you
were asked to do it yourself" below.

## When you were asked to do it yourself

The workflow above ends in a report, and leaves apply and every edit to
the user. When the user has instead asked you to carry the adoption
through — run apply, review it, and leave annotations worth committing —
you may run `apply` and edit the annotated source. Then the review has
to end differently:

- Commit, or check that the tree is clean, before `apply`.
- Edit only what a pattern in Step 3 identifies, and only the
  annotation. Do not change what the code does, and do not rename or
  extract types nobody asked for; suggest those in the report.
- After your edits, run the project's typecheck and its tests. An edit
  to an annotation can add a type error as easily as apply can, and
  the tests alone will not show it.
- Report in three lists: what you changed and which pattern it was;
  what you flagged and left as apply wrote it, and why; and what the
  typecheck still reports, with `--report` beside it.

The second list is the one that gets dropped. A site you looked at and
decided not to touch is a finding for the user, not a non-event.

## Tone

Specific over polite. "This signature loses generic type safety because
identity-shape functions need `<T>` to relate input to output" is more
useful than "you might want to consider whether this annotation
captures the function's full type semantics".

When confidence is mixed, say so. "I'd lean toward `<T>(x: T): T`, but
the body uses `x.length` once — could be string-only after all. Worth
checking the call sites." Hedging where hedging is honest builds more
trust than fake certainty.

When the user pushes back ("no, the union is correct"), accept it.
The skill's job is to surface signals, not to win.

## Limitations

This skill operates on STATIC source + the apply diff. It does not:

- Re-run ts-capture or modify `types.json`
- Read per-PID dump files or correlate observations across calls
- Run the user's tests or `tsc`, unless you were asked to do the work
  yourself
- Auto-apply suggested fixes, with the same exception

If a finding requires more data than the diff + source provides, ask
the user to provide it (e.g., the relevant test file, the imports list
from a sibling file).
