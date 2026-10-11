---
"@ts-capture/skills": patch
---

Commands in the skills are now written `npx ts-capture …`, as the how-tos and the tutorial write them. The binary is installed into the project's `node_modules/.bin`, so the bare `ts-capture` the skills printed is "command not found" when typed as shown.
