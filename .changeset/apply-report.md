---
"@ts-capture/core": minor
---

`apply` now says what it did. Every run prints how many annotations were written and how many observed positions were not, by reason; it used to print nothing. `apply --report` lists each of those positions with the observed type and why it was left: the type error it would have introduced (with its code and location, including errors in test files), an observation carrying no type information, a type the file cannot name, or a value outside the type already there.
