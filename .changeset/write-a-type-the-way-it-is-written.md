---
"@ts-capture/core": patch
---

Annotations are spelled the way TypeScript spells them.

`apply` wrote unions as `number|string` and separated object members with commas, which formatters rewrite, so a clean apply left a failing format check. Types are now respelled as they are written into a file, keeping parameter names and member order.
