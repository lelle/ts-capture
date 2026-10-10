---
"@ts-capture/core": patch
---

Annotations read the way people write them. In a union written to source, `null` and `undefined` now come last (`string | null | undefined` instead of `null | string`), and an array of a union is written `(A | B)[]` instead of `Array<A | B>`, the form apply already used for `T[]`. Only the text written to source changes; `types.json` and the comparisons apply makes before writing are unchanged.
