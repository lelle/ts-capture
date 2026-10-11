---
"@ts-capture/babel-plugin": patch
---

Under Jest, the observations of every test file are now kept. Jest starts a collector per test file, and each wrote the same per-process dump, so only the last file to write survived — a six-file suite gave 3 annotations where Vitest gave 40 on the same code. Each collector now writes a dump of its own, `ts-capture-types-<id>.json`; `ts-capture merge` reads them as before.
