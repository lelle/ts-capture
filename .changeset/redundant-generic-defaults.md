---
"@ts-capture/core": patch
---

An annotation that names a generic with defaults is recognised as one TypeScript already infers, and is not written. `cond` in `conditions.some((cond) => cond(c))`, where `conditions` is `((c: Context) => boolean)[]` and `Context` is `interface Context<Env = any>`, was written as `cond: (c: Context) => boolean`. TypeScript spelled its own type `(c: Context<any>) => boolean`, so the two read as different types.
