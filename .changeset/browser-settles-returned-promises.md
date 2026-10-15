---
"@ts-capture/vite": patch
---

In the browser, a function that returns a promise is now observed as what the promise resolved to (`Promise<T>`), as under Node, instead of a bare `Promise`. A promise that rejects records nothing. Following the promise registers a reaction, which marks a rejection as handled.
