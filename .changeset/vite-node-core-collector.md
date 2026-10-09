---
"@ts-capture/vite": patch
---

Under Node (Vitest, SSR) the plugin now collects through `@ts-capture/core`'s own collector instead of its built-in copy. A parameter that receives a callback is typed with the signature observed for that callback, such as `fn: (value: number) => number`, where it used to stay untyped. The built-in collector remains for the browser and as the fallback when the core package cannot be resolved from the running module.
