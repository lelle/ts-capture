---
"@ts-capture/skills": patch
---

The apply-review skill has a seventh pattern: object shapes that describe the test data rather than the code. It names three marks — literal keys on a value indexed by a variable, a required field the function body never reads, a lookup typed as if it always hits — says what to suggest for each, and for the second gives a check to run at every object-typed parameter, with what `infer.narrowParamShapes` covers of it and what it leaves.
