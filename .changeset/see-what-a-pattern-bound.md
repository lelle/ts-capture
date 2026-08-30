---
"@ts-capture/core": minor
"@ts-capture/svelte": patch
---

Destructured declarations are observed and annotated.

`let { host, guest } = $props()` and `const { a, b } = obj` are now captured: the bound values are reported in a statement after the declaration, which is left as written so a Svelte rune stays the direct right-hand side. Object patterns only; array, rest and nested patterns are skipped. The Svelte runes ambient now declares `$props(): any` as Svelte does, so props annotations are no longer silently suppressed.
