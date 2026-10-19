---
"@ts-capture/core": patch
---

A paren-less arrow whose return type is written while its parameter is not (`xs.forEach(x => x.close())`) now gets its parentheses, `(x): void => …`, instead of the unparseable `x: void => …`.
