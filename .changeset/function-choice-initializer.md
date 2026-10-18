---
"@ts-capture/core": patch
---

A variable initialized with a choice between functions, `const compare = asc ? (a: number, b: number) => a - b : (a: number, b: number) => b - a`, is left with the types its functions already have, as a single arrow is. `apply` could write a union of the observed function types over it, with `unknown` for a branch the tests never called.
