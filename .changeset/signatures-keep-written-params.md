---
"@ts-capture/core": patch
---

A function passed as a value now gets a signature with all its parameters when some of them have a written type. `function k(a: string, b)` passed as a callback was typed `(b: number) => string`, which put `b` in `a`'s place; it is now `(a: string, b: number) => string`, with the written type kept as written. Observing written types for `verify` with `TS_CAPTURE_OBSERVE_ANNOTATED=1` no longer changes these signatures, so it no longer changes what `apply` writes.
