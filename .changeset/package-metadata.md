---
"@ts-capture/core": patch
"@ts-capture/vite": patch
"@ts-capture/babel-plugin": patch
"@ts-capture/esbuild": patch
"@ts-capture/svelte": patch
"@ts-capture/skills": patch
---

`engines` says Node `>=20.19`, the oldest Node the packages run on: `@ts-capture/babel-plugin` loads Babel 8 with `require()`, which Node supports for ES modules from 20.19. `@ts-capture/babel-plugin` lists its `types` condition first, so TypeScript resolves its declarations by the condition rather than by the file next to the JavaScript.
