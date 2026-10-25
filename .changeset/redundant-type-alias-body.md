---
"@ts-capture/core": patch
---

An annotation that spells out the body of a type alias is recognised as one TypeScript already infers, and is not written. `cond` in `conditions.some((cond) => cond(c))`, where `conditions` is `Condition[]` and `type Condition = (c: Context) => boolean`, was written as `cond: (c: Context) => boolean`. TypeScript spelled its own type `Condition`, so the two read as different types.
