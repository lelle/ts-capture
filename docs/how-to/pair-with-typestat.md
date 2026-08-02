# Pair with TypeStat for full any-removal coverage

Goal: remove `any` across a codebase by combining ts-capture with
[TypeStat](https://github.com/JoshuaKGoldberg/TypeStat). The two tools cover
**disjoint** slices of the JS-to-typed-TS migration, so they compose rather
than overlap.

ts-capture observes runtime values to infer types TypeScript _can't_ — function
parameters, callback args, and locals where the type checker gave up and emitted
`any`. The inverse problem — annotations a developer wrote that TypeScript
_could_ have inferred (`let count: number = 0`) — is what TypeStat's
`noInferableTypes` fixer removes; its `convertJsToTs` mutation handles the
file-rename + scaffold work ts-capture doesn't touch.

| Case                                            | Tool                               |
| ----------------------------------------------- | ---------------------------------- |
| `function foo(a) { ... }` (param is `any`)      | ts-capture — observe call sites    |
| `const x = JSON.parse(s)` (TS infers `any`)     | ts-capture — observe runtime shape |
| `let count: number = 0` (annotation redundant)  | TypeStat — `noInferableTypes`      |
| Mixing JS into a TS project (whole-file rename) | TypeStat — `convertJsToTs`         |

## Recommended order

1. **TypeStat first** — clean up redundant annotations and convert files.
2. **ts-capture second** — fill in the residual `any` from observed test runs.

ts-capture's own `infer.skipInferableVarDecls` flag (off by default) applies the
same "don't add what TS would already infer" idea prophylactically during
apply, so iterating between the two tools doesn't reintroduce the noise TypeStat
just cleaned up. See the
[configuration reference](../reference/configuration.md#infer).
