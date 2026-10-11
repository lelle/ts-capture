---
"@ts-capture/babel-plugin": patch
---

Under Jest, the last observations of a test file are no longer lost. A worker ends without the exit handlers running, and a short file finishes before the half-second tick, so whatever came after the last tenth observation was never written — a six-file suite gave 131 merged entries where Vitest gave 151. The collector now queues a write behind each burst of observations.
