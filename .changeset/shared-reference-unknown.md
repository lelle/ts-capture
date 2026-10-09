---
"@ts-capture/core": patch
"@ts-capture/vite": patch
---

An object that appears more than once inside an observed value is now described every time, instead of as `unknown` from its second appearance on. The cycle guard remembered every object it had walked rather than only the ancestors of the current one, so two orders sharing one customer produced `customer: unknown` and annotations such as `lines: unknown | Line[]`. True cycles are still cut.
