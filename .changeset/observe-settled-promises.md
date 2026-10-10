---
"@ts-capture/core": minor
"@ts-capture/babel-plugin": patch
"@ts-capture/vite": patch
---

A function returning a hand-built promise now gets a return type. The runtime keeps returned promises aside and, at each flush, records the value of every one that has fulfilled as `Promise<T>` at the return position; it used to record `Promise<unknown>`, which `apply` drops. A promise's state is read without touching it, so a rejected promise is left exactly as it was and unhandled-rejection reporting is unchanged. Node runtimes only: the browser collector is as before. The Babel runtime and the Vite plugin call the new sweep before flushing.
