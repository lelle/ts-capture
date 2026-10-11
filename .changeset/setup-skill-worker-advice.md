---
"@ts-capture/skills": patch
---

The setup skill no longer writes a worker setting into the Vitest config by default. For Vitest 4 and later it wrote `fileParallelism: false` as the way to a single worker, which runs the files one after another and still starts a process for each — twice the run time on a small suite, for nothing. Running in one process is now advice for a suite where the instrumented run is slow or hangs, with the two options it takes on Vitest 4+ and what turning isolation off costs.
