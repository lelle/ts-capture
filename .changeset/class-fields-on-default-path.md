---
"@ts-capture/core": patch
---

`apply` now types a class field from the constructor parameter assigned to it. In `class Counter { count; constructor(initial) { this.count = initial; } }`, with `initial` observed as a number, `count` is written `count: number`. The default applier had left the field untyped, because the inference only saw the entries it did not handle itself, and the constructor parameters were never among them.
