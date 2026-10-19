---
"@ts-capture/core": minor
---

`ts-capture apply` now writes through `annotateProject`. A file the tsconfig does not list is type-checked against the project before an annotation is written to it, as the files it lists are; before, its annotations were written unchecked. `infer.cstAware` has no effect any more and prints a warning when set to `false`; it will be removed.
