---
"@ts-capture/core": minor
---

Notes say which position they are about, and both appliers place them by one
rule.

**Every note names its site.** One line can hold several:
`const a = (s) => (d) => (e) => e;` has three, and notes stacked above it were
indistinguishable — beside the annotation they were literally identical.

**A crowded line gets its notes at the sites instead of above it.** No name
survives the hard case — `const a = (d) => (d) => (d) => null;` has four
positions with one name between them, and a qualifier taken from the source is
unbounded, since a parameter list can be longer than the type it introduces. At
the site there is nothing to name, because the position is the identifier:

```ts
const a =
  (d /* @ts-capture[proposal]: would be `string`; observed once */) =>
  (d /* @ts-capture[proposal]: would be `number`; observed once */) =>
    d;
```

The inline form is a block comment, which delimits itself, so removal takes
exactly the note and nothing of the code around it. Contradictions count toward
whether a line is crowded: left out of the count they put two formats on one
line and kept the naming collision they were meant to resolve.

**Each note carries what it is, in a word** — `[conflict]`, `[proposal]` or
`[applied]`. Reading a diff, the `+` on the code line says whether an annotation
was written; reading the file it is gone, and the signal becomes an annotation
that is _missing_, which is not something a reader spots. It also makes the
findings greppable: on nestjs/nest 10 notes of 135 are the ones to act on, and
separating them otherwise means matching on wording.

**One placement rule, for real.** Where a note goes now lives in one function
that both appliers call. It had lived in the CST applier alone, so a
pass-through entry on a crowded line came out in the old ambiguous form —
invisible until a project routes through the second path, and nestjs/nest does
not. Two divergences went with it: a contradiction whose note could not be
placed abandoned the offset applier's whole entry loop, dropping every remaining
annotation in the file; and a preview whose line began inside a template was
discarded by one applier and written at the site by the other. A contradiction
now settles its site whether or not the note lands, and the leading-line check
is asked only where a leading line is what gets written.
