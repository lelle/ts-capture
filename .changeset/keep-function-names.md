---
"@ts-capture/core": patch
---

Instrumented code now keeps the names of its functions and classes. A function or class that takes its name from where it is defined, such as `const handler = () => …`, `{ onClick: () => … }`, `class K { field = () => … }` or `const Model = class {}`, lost that name once the instrumenter wrapped it in a call, so `handler.name` was `""` during the run. Code that reads `.name`, such as middleware that reports itself by name, a container keyed on class names, or a snapshot of a function, behaved differently under ts-capture. This affected every integration. The instrumenter now places the function where JavaScript names it.
