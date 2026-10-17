---
"@ts-capture/core": patch
---

`node --import @ts-capture/core/register` now runs. Every file it instrumented stopped at `ReferenceError: __tscptr__ is not defined`. Node runs module loaders on a thread of their own, and the loader set up the runtime there, where the program cannot see it. The runtime and the write-back on exit now live in `register`, on the program's thread, and a function that returns a promise is typed with what the promise resolved to. The how-to now says that `register` needs a Node that runs `.ts` itself (22.18 or 23.6 and later), and what type stripping leaves out.
