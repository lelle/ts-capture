---
"@ts-capture/core": patch
---

`apply` no longer drops a local, class field or callback annotation because an edit earlier in the same file moved an error the file already had. The type-check oracle remembered each existing error by its offset, so once the first pass over a file had inserted text before one, the second pass took it for a new error and rejected every candidate it probed. The file's errors are now read again where they sit after each pass.
