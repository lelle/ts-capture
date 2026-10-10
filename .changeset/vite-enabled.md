---
"@ts-capture/vite": minor
---

The Vite plugin can be switched off without removing it from the config. `enabled: false` leaves nothing instrumented, writes no dumps and mounts no dev-server middleware; `TS_CAPTURE_ENABLED=false` in the environment does the same for one run. Until now every test run with the plugin configured instrumented all files and wrote dumps to the temp directory, and the only ways around it were a conditional plugin list or `exclude: /./`.
