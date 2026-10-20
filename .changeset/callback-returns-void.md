---
"@ts-capture/core": patch
---

A callback parameter whose function returned nothing is written as `() => void`, not `() => undefined`, which rejected every caller whose callback returns something.
