---
"@ts-capture/core": minor
---

Apply says when it has no project to check against, and takes `--project` to
name one.

The nearest `tsconfig.json` is what apply typechecks against, found by walking
up from the working directory. A solution-style config — `"files": []` plus
`references` — is the standard shape for a TypeScript monorepo, and discovery
finds it. It builds a Program with nothing in it, and every check that needs
one turns off together: the redundancy oracle, the five suppression rules, the
contradiction report. Apply carries on with its syntactic guards, which is a
defensible fallback and a bad thing to do in silence — the only trace was two
telemetry counters reading zero, and the result was an order of magnitude more
annotations and a build that no longer compiled.

Apply now names the problem when the project it found holds no files. Which
referenced project to use instead is not something it can guess: they carry
different `compilerOptions`, and answering from the wrong one is worse than not
answering. So `--project <tsconfig.json>` says which one covers the sources
being annotated, spelled the same way `verify --project` already is.
