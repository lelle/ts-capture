---
"@ts-capture/svelte": minor
---

The Svelte plugin writes through the same applier as `ts-capture apply` and returns what it skipped, so `apply --report` now lists the positions in a `.svelte` file it left untyped, and why, at their line and column in the component. `applySvelteTypesToFile` follows the CLI's rules for `.ts` files.
