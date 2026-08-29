---
"@ts-capture/skills": patch
---

The setup skill stops sending users into the failure it exists to catch.

Under Vitest browser mode, observations reach the plugin's middleware and are discarded unless `outputFile` is set; the skill now says so instead of pointing at `TS_CAPTURE_TYPES_DIR`. Pool advice now follows the Vitest major, since Vitest 4 moved `poolOptions` to the top level.
