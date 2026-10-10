---
"@ts-capture/core": minor
"@ts-capture/vite": patch
---

A short array of mixed element kinds is observed as a tuple: `[key, value]` holding a string and a number is written `[string, number]` instead of `Array<number | string>`. Arrays of two or three elements qualify when their elements are of more than one kind, with literals widened for the comparison; same-kind and longer arrays stay arrays. At one position, same-arity tuples merge element-wise, and a tuple seen beside an array or a tuple of another length widens back to an array. The Vite browser collector mirrors the rule, and now spaces the element union of a mixed array the way core does.
