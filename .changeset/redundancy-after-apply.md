---
"@ts-capture/core": patch
---

`apply` no longer annotates a local, class field or callback parameter that TypeScript infers once the same run has typed the function it depends on. Redundancy used to be judged against the project as it was on disk, where an untyped callee returns `any`, so `const net: number = applyCoupon(...)` was written although `applyCoupon` got its return type in the same pass. A file's parameters and return types are now written first and its dependent sites are judged against the result; files are processed in import order so a callee typed in another file counts too. The second pass runs when `typecheckVerify` is on, which it is by default.
