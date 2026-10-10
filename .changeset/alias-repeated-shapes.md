---
"@ts-capture/core": minor
---

New opt-in `infer.aliasRepeatedShapes`: a shape that several annotations in one file spell out is declared once, after the imports, and written as its name at each of them. The declaration is named after the first position that holds the shape, so `product` gives `type Product = { ... }` and an array `products` gives `Product` too; a name the file already uses is passed over. The type-check oracle verifies each annotation with the declaration beside it, and the declaration is written only when an annotation naming it is.
