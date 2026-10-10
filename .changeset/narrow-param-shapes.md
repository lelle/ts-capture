---
"@ts-capture/core": minor
---

New opt-in `infer.narrowParamShapes`: a parameter's object shape is written with only the properties the function body reads from it. The observed shape is the caller's object, and under a test run that is a fixture, so every key the fixture carried became a requirement on every caller. The whole shape stays wherever the body passes the parameter on, returns it or stores it, and a shape that matches an in-scope type in full is written as that type, as before.
