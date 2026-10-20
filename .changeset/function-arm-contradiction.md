---
"@ts-capture/core": patch
---

A callback the run passed `undefined` where TypeScript types it as a function is reported as a contradiction instead of written as `(() => void) | undefined`. The function arm read differently inside a union than on its own, so the disagreement was never seen.
