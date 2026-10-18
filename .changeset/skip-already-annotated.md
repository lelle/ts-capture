---
"@ts-capture/core": minor
---

A position that already has a written type is now a skip with the reason `already-annotated`, at its position, instead of only a count. `annotate` returns it with the other skips, and `apply --report` counts it under "Nothing to add" as before. `ApplySkipReason` has two new values, `already-annotated` and `no-site`.
