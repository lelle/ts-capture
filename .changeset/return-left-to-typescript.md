---
"@ts-capture/core": patch
---

Apply now writes TypeScript's type for a return that the run saw narrower than what TypeScript infers once the parameters are written. An example is a `return null` branch the tests never took, which gives `{ id: number } | null`. Before, the return was left untyped and reported as a type error. The type is spelled the way apply spells its own, under the rule `verify.wider-after-run`. If TypeScript already inferred that type before the run, the return is left to TypeScript unless `skipRedundantAnnotations` is off. An observation that only misses a union arm TypeScript has is now reported as left to TypeScript, not as kept-existing.
