---
"@ts-capture/core": patch
---

Apply no longer writes a second `this` parameter into a function that already declares one (`greet(this: Date, this: Date)`, which does not parse). The entry is skipped as already annotated.
