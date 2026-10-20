---
"@ts-capture/core": patch
---

A function observed as a value is no longer kept alive by the collector. Before, every callback passed through an instrumented function was held for the rest of the run, with the scope it closed over, so a long `register` or dev-server session grew in memory for as long as it ran.
