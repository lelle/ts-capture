---
"@ts-capture/core": patch
"@ts-capture/vite": patch
"@ts-capture/babel-plugin": patch
---

A type first seen at an already-observed position late in a run is now written to the dump. The collectors only rewrote the dump when a new position appeared, so a later `null` or second union member at a known position stayed in memory and never reached `types.json`. Annotations that were silently missing a union member, or dropped because the incomplete type failed the type-check, can now be written.
