---
"@ts-capture/core": patch
---

`Array<T>` and `T[]` are one type to the redundancy check. An observed `Array<A | B>` at a position where TypeScript already infers `(A | B)[]` is now left alone instead of being written as a restatement.
