---
"@ts-capture/core": patch
---

`apply` now annotates the parameter of an array-method callback when the receiver is untyped. Object-typed callback parameters are skipped because TypeScript takes them from the array's element type, but the skip went by the method's name: on `cart.lines.find((line) => …)` with `cart` still `any`, nothing was inferred, the observed type was dropped, and `--report` listed the position as "already inferred by TypeScript" while the compiler reported it as implicit `any`. The accumulator of `reduce` is left as it was: it is not an element, and where the checker has it as `any` the observed type is what the callers built up.
