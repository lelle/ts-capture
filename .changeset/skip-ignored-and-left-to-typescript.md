---
"@ts-capture/core": patch
---

Every observed position `apply` leaves alone now has a reason in `apply --report`. A declaration marked `@ts-capture-ignore` is counted under "Nothing to add" as `marked @ts-capture-ignore`. A variable left for TypeScript to infer says why: its initializer is a function with its own types, passes type arguments or sits in a generic function (the code already says more), or only one branch of its initializer, or only `undefined`, was observed (no type information). `ApplySkipReason` has a new value, `ignored`.
