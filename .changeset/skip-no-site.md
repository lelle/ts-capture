---
"@ts-capture/core": patch
---

An observation whose position is no place a type can go, typically because the code changed since the run, is now listed in `apply --report` under "No place to write it" instead of being dropped without a word. `apply` no longer hands such entries to a second, offset-based applier.
