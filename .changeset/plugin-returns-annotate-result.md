---
"@ts-capture/core": minor
---

An applier plugin's `apply` may return an `AnnotateResult` (`{ text, skips, telemetry }`), with skip positions relative to the source it was given. `ts-capture apply` then counts what the plugin wrote and lists what it skipped in `--report`. Returning a plain string still works, with nothing to report, and is deprecated.
