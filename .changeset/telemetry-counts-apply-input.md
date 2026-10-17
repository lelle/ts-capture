---
"@ts-capture/core": patch
---

`apply --telemetry` no longer counts observations that are not input to `apply`: those of a type you wrote, made for `verify` with `TS_CAPTURE_OBSERVE_ANNOTATED=1`, and the returns of callback parameters. They were listed as "Other (heuristic skip)" and lowered the emitted percentage, though what `apply` wrote was the same.
