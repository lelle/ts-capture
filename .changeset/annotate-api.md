---
"@ts-capture/core": minor
---

New `annotate(text, entries, options)` and `annotateProject({ types, readFile, oracle })` write observed types and return the text together with every skipped entry and its reason, instead of a bare string. How much they may ask TypeScript is one `oracle` option: `none` (syntax only), `program` (the checker of a `ts.Program`) or `project` (each candidate type-checked against the project before it is written, files taken in import order). They are the entry points the integrations will move to; `applyTypesToFile` and `applyTypesToFileCst` keep working for now.
