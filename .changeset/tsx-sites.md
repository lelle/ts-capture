---
"@ts-capture/core": patch
---

Apply reads a `.tsx` or `.jsx` file as JSX. It read every file as plain TypeScript, so in a component file the code after the first JSX element was misread and its observations were dropped.
