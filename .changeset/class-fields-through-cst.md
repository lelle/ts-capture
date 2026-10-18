---
"@ts-capture/core": patch
---

A class field typed from its constructor parameter now goes through the same checks as every other site. With the type-check oracle on (the CLI default), a field TypeScript already infers from the constructor's assignment is left as it is instead of being restated, and a field that is not written is listed in `apply --report` with the reason.
