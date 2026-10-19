---
"@ts-capture/core": minor
---

There is one applier. `applyTypesToFile`, `applyTypesToFileCst` and `applyTypesToFiles` are deprecated in favour of `annotate` and `annotateProject`; `applyTypesToFile` now runs the same applier as `annotate` instead of the offset-based one, so its output follows the same rules as `ts-capture apply`. The options that only steered the hand-off between the two appliers (`checkerSites`, `stripConflictNotes`, `inferClassFields`) are gone.
