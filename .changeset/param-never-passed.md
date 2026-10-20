---
"@ts-capture/core": patch
---

A parameter no call passed is no longer written as `: undefined`, which made every later call that passes it a type error. Apply leaves it alone and reports it as `no-information`: "every call left it out".
