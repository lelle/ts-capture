---
"@ts-capture/core": patch
---

A list of objects that differ is written as one object type with optional fields wherever it sits, not only when it is passed on its own. A list inside an object used to be written as a union of near-identical objects, and lists of objects that differed between calls as a union of arrays, which the calls themselves failed against, so nothing was written. Lists of primitives, and objects told apart by a literal field, stay as they were. `infer.recursiveObjectMerge: false` keeps them apart, as before.
