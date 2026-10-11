---
"@ts-capture/skills": patch
---

The setup skill now says which files to ignore: `.ts-capture/`, `types.json` and `types.json.applied`. It created all three in the project and asked for a commit before `apply`, without ever mentioning `.gitignore`.
