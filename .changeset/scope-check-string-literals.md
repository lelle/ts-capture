---
"@ts-capture/core": patch
---

A capitalised word inside a string literal, a capitalised property key and a capitalised parameter name are no longer mistaken for type names. The scope check read names off the raw annotation text, so with string literals enabled `"World"` or `{ first: "Ada" }` looked like a reference to an unknown type and the whole annotation was skipped; `{ Name: string }` was skipped the same way with literals off. Names are now read from the parsed type.
