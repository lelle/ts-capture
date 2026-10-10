---
"@ts-capture/core": patch
---

`verify` now says where each mismatch is and what it could not check. A mismatch is printed as `file:line:col` with the declaration name, the declared type and the observed types, instead of a character offset. The totals line breaks the unverifiable positions down by reason (declared `any`, a generic the heuristic can only compare for equality, and so on). Three comparisons that were text artefacts no longer count as mismatches: an inferred `any[]` is unverifiable like `any`, polymorphic `this` is unverifiable, and an observed `undefined` matches an inferred `void`. The documentation now says what `verify` compares against: the type TypeScript has at each observed position, which is what it infers, since annotated positions are not instrumented.
