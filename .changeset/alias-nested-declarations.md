---
"@ts-capture/core": patch
---

`infer.aliasRepeatedShapes` now declares a shape that only another declared shape names. A repeated `Order` holding a repeated `Customer` got `type Order = { customer: Customer; ... }` without `type Customer`, so the type-check gate rejected every annotation naming `Order` and the positions stayed untyped.
