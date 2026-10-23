---
"@ts-capture/core": minor
---

Every site apply skips now names the rule that decided it, as `rule` on the skip. `--report` prints it under the observed type, for example `rule  verify.type-error`. One reason has several rules behind it. `kept-existing` alone can be an enum, a named type, a polymorphic `this` or a dropped union arm. Written sites are recorded too, in `telemetry.written`, and `APPLY_RULES` lists every rule.
