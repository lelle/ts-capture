# What it cannot infer

Runtime observation has fundamental limits — some types can't be reconstructed
from runtime data alone. ts-capture is conservative (it only fills empty
positions and gates every candidate through the TypeChecker), but you should
know where it stops short, and how `apply` behaves in those cases.

## Generics are flattened to observed unions

A generic function used with several types is recorded as the union of what was
seen, not as a type parameter.

```ts title="Input"
// Called with both a string and a number across the test run
function identity(x) {
  return x;
}
```

```ts title="Current"
// Flattened to the observed union, not generalized to <T>(x: T) => T
function identity(x: string | number): string | number {
  return x;
}
```

A later call with a _new_ type would then be a TS error. **Workaround:** preview
with `apply --dry-run` and generalize to `<T>` by hand where it matters.

## Mixed-type union arithmetic produces TS errors

```ts title="Input"
// Exercised with both strings and numbers
function add(a, b) {
  return a + b;
}
```

```ts title="Current"
// `+` on `string | number` is itself a TS error
function add(a: string | number, b: string | number) {
  return a + b;
}
```

**Workaround:** narrow in source, or split into overloads.

## Already-typed declarations are respected

ts-capture never overwrites an existing annotation. `const f = (x: T) => U`
keeps its `T`/`U`; only _missing_ inner annotations get filled.

## Observation is not side-effect free

Describing a value means reading its properties, so **getters run and `Proxy`
get-traps fire** during observation. Accessors that lazily initialize, count,
mutate, or issue requests will run more often with ts-capture loaded. See
[Observation reads your values](how-it-works.md#observation-reads-your-values--including-getters).

## Only the code paths you actually ran

Nothing warns you that a position was under-observed — it simply gets a type
derived from the calls that happened, or none at all. See
[Why runtime observation](why-runtime-observation.md#the-case-for-observing-at-runtime).

## Observation cost on large codebases

Instrumenting every file in a large suite can consume substantial time and
memory. Scope collection with `exclude`, use a single-fork pool, or run test
subsets when a full instrumented suite exceeds available resources — accepting
that a subset yields narrower types, and re-observing later when it matters.

## Help at apply time

The [`ts-capture-apply-review`](../../packages/skills/ts-capture-apply-review/SKILL.md)
skill flags the generic-flattening and union-arithmetic patterns above at apply
time. Always preview with `apply --dry-run` first — see
[Review & apply safely](../how-to/review-and-apply-safely.md).
