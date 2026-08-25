---
"@ts-capture/core": minor
---

Apply leaves a note where the run contradicts the project's own types.

Every other output of apply is an annotation, checked by the TypeChecker and
then by `tsc`. These are not: they are findings, addressed to a person. A
position TypeScript infers as `string` where the code produced `undefined`
during a real run is either a bug in the code or a wrong type, and which one
cannot be decided from the observation — so apply reports it and leaves the code
alone:

```ts
// @ts-capture: `pattern` observed `undefined`, TypeScript infers `string`
const pattern = this.getPattern(packet);
```

Apply owns these notes and rewrites them on every run: every whole line carrying
`// @ts-capture:` is removed before the current set is written, so a note whose
conflict is gone — or whose code is gone — cannot survive to lie about the file.
**A `// @ts-capture:` line written by hand is removed too.**

**Nullish arms only, and the first run on nestjs/nest is why.** Comparing arms as
text calls every difference a contradiction, and almost none of them are: 437
notes, of which 10 were real. `Map<unknown, unknown>` against
`Map<InjectionToken, InstanceWrapper<unknown>>` is not the run seeing something
impossible, it is the run seeing less (211 of those); `string` against `"host"`
is the run reporting the widened base of a literal (152). Both are what the
suppression rules already describe. Seeing `undefined` where the checker says the
value is always a `string` is different in kind: a claim about reachability that
the type forbids, and text is enough to establish it. `void` and `undefined` are
one claim about a value that is not there, and count as the same arm.

**Both appliers write notes.** The offset-based applier serves pass-through
entries even on the default path, so contradictions found there went unreported.
Only the entry point removes the old notes: when the CST pass hands its
pass-through entries over, the source it hands on already carries the notes it
just wrote, and a second strip would delete them.

**No note is written into text.** A note goes in at the start of the line it
describes, and inside a multi-line template that start is inside the string — the
comment becomes text and its backticks close the template early. The safety check
parses in the dialect the file's extension implies: reading a `.ts` file as TSX
takes `const f = <T>(v: T) => v;` for a JSX element and invents JsxText over
ordinary code, which refused a real note on nest for a line inside nothing.

Set `infer.emitConflictComments` to `false` to turn notes off. Like the other
checker-backed rules, they need a project.
