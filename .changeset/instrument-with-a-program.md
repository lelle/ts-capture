---
"@ts-capture/core": minor
---

`instrumentSource` takes a `program` option: a Program the caller already has, which `instrumentImplicitThis` asks where `this` is implicitly `any`. A caller without a tsconfig, such as the browser, can now observe `this` too.
