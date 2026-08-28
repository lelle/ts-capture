---
"@ts-capture/vite": patch
---

The browser collector now delivers on the next macrotask instead of waiting for the 10-second ticker.

Test-runner pages such as Vitest browser mode were torn down before the first tick, leaving an empty output file. In browser mode, set the plugin's `outputFile` option; `TS_CAPTURE_TYPES_DIR` has no effect there.
