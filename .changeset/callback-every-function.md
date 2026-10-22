---
"@ts-capture/core": patch
---

A callback parameter passed different functions is typed from all of them, such as `(() => number) | (() => string)`. It used to take the first function's signature only, so apply left the parameter unwritten because the other calls failed the type check.
