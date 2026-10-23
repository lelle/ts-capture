---
"@ts-capture/core": patch
---

The `apply` report now names a `this` parameter `this`, and a destructuring by its pattern, such as `{ size }`. Before, both were reported as `return type`.
