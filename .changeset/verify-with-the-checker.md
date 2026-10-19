---
"@ts-capture/core": minor
---

`ts-capture verify` now has TypeScript compare what the run saw with the type at each position, where the text comparison could not decide. Named and structural types are now settled: on honojs/hono and nestjs/nest the share of written types reported unverifiable falls from about half to about a fifth, and no type that matched before stops matching. New reasons say why the rest cannot be decided (`generic declared type`, `name not in scope`, `declared narrower than observable`, …).
