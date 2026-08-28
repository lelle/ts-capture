---
"@ts-capture/core": patch
---

Verification no longer mistakes a moved diagnostic for a new one.

An annotation's insertion shifted every diagnostic below it, so pre-existing errors read as new and apply refused every annotation above the first uncovered site in a file. Probe offsets are now translated back to the baseline's coordinates; text the candidate inserted still counts as new.
