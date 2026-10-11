---
"@ts-capture/core": minor
---

`apply --dry-run` now prints what it would change as a unified diff, after the list of files. The docs, the tutorial and the apply-review skill have always called the dry run a diff to read before applying, and it printed only file names. The list of files and the summary lines are unchanged, so a script that reads them keeps working; nothing is written to disk, as before.
