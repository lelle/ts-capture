---
"@ts-capture/core": patch
---

A union whose arms hold a function type is now taken apart correctly when observations are merged. The `>` of `=>` was read as closing a bracket, so `{ f: () => void } | string` counted as one arm. Among other things, an array of objects with a function member, such as `Array<{ a: null, f: () => void } | { a: number, f: () => void }>`, is now merged to `{ a: null | number, f: () => void }[]` like any other array of objects.
