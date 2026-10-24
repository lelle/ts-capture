---
"@ts-capture/core": patch
---

A returned function's parameters keep the types the code writes for them. A returned `(request: Request) => Promise<void>`, where `Request` is `interface Request<Body = any>`, was written as `(request: Request<unknown>) => Promise<void>`. A generic type ts-capture only observed at run time is still written with `<unknown>`.
