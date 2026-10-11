---
"@ts-capture/core": minor
---

New experimental entry `@ts-capture/core/browser`: the engine without Node. It exports `instrumentSource`, `createObserver` (a collector with the `__tscptr__` hook to hand to instrumented code) and `applyInMemory`, which applies observations to a project read through a `ts.System` you supply and runs the same type-check gate as `ts-capture apply`. `createProjectVerificationContext` takes that system as an optional fourth argument. In a runtime that cannot inspect a promise, a returned promise is followed to see it settle, which marks a rejection as handled. The entry may change in any 0.x release.
