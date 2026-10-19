---
"@ts-capture/core": patch
---

A union of observed types is split at its real arms everywhere: a `|` inside a string literal or inside the class-chain marker (`captureClassHierarchy`) no longer cuts an arm in two.
