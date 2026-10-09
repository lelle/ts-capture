---
"@ts-capture/core": patch
"@ts-capture/vite": patch
"@ts-capture/babel-plugin": patch
---

The collectors decide whether to rewrite the dump from a cheap change counter instead of building the collected output each time. On hono's suite (3944 tests) an instrumented run with the Vite plugin takes about as much CPU as 0.1.0 while now resolving callback types, and wall-clock time is lower. `CollectionContext` gains `revision()`, which changes whenever `getCollectedTypes()` would return something different.
