---
"@ts-capture/core": minor
---

`typesFromValues(values, options)` gives the type apply would write for a parameter called once with each value, without instrumenting any source: parsed JSON, a fixture, an object at hand. It takes the same `infer` and `literalOptions` as the rest of ts-capture, and a `maxDepth` for values nested deeper than observation reads by default, and with `infer.aliasRepeatedShapes` it declares the shapes the values repeat, under names other than the `rootName` it gives for `name`. `infer.literal` also decides which literals are observed unless `literalOptions` says otherwise. It is exported from `@ts-capture/core` and `@ts-capture/core/browser`.
