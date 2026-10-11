---
"@ts-capture/skills": patch
---

The setup skill now writes the Vitest plugin the way the docs do, `import tsCapture from "@ts-capture/vite"`. The README, the how-to, the Vite package README and the skill each had a quick start of their own, and they disagreed on the import, the worker option and the dump directory.
