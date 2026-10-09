---
"@ts-capture/core": patch
---

An empty array observed inside an object no longer competes with a filled one at the same key. `{ lines: [] }` and `{ lines: [{ sku }] }` at one position used to merge to `{ lines: unknown[] | { sku: string }[] }`, which fails the type-check and was dropped; the empty observation now gives way, as it already did for a top-level array.
