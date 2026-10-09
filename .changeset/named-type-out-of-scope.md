---
"@ts-capture/core": patch
---

An observed object shape is no longer dropped because it happens to match a named type declared in a file the target does not import. `preferNamedInScope` rewrote the shape to that name, the name failed the scope check, and the valid structural annotation was lost with it. Only types the target file can name are now considered, so the shape is written structurally instead.
