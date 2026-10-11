---
"@ts-capture/skills": patch
---

The apply-review skill now says what is left after apply: a strict project usually still fails typecheck, because unexercised code is not observed, test files are skipped and an annotation that would add an error is not written. It points at `apply --report` for the positions and their reasons, which the review path never mentioned.
