---
"@ts-capture/vite": patch
---

`outputFile` keeps every page's observations, not just the last one's.

Vitest browser mode posts once per page, and each POST overwrote the file, so which page survived was a race. The first POST a dev server serves still replaces the file; the rest add to it.
