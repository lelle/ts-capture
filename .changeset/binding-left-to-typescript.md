---
"@ts-capture/core": patch
---

A variable whose observed type is narrower than the type TypeScript infers from its initializer is reported as left for TypeScript to infer, not as a type error. An example is `const fromNull = valuesOrNull(null)` once `valuesOrNull`'s return type is written. Nothing is lost there: TypeScript already has a type that holds what the run saw.
