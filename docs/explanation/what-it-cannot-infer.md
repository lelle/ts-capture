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

## A pair of the same kind is a list

A short array whose elements are of different kinds is recorded as a tuple:
`[key, value]` with a string and a number becomes `[string, number]`, and two
runs that saw `[string, number]` and `[string, null]` merge to
`[string, null | number]`. An array whose elements are all of one kind stays an
array, however short, because `[x, y]` is more often a list than a pair, so a
pair of numbers is `number[]`. Arrays of more than three elements are always
arrays. When one run sees a tuple and another sees an array, or tuples of
different lengths, the position widens back to an array of every element type.

## A returned promise is observed when it settles

A function that returns a promise it built by hand, `new Promise(...)` or a
`.then` chain, gets `Promise<T>` from the value the promise settled with. The
runtime keeps the returned promise aside and looks at it on each flush, every
half second and at exit: one that has fulfilled is read and recorded, one still
pending waits for the next flush, and one that rejected is never touched, so a
rejection nobody handles is reported exactly as it would be without
observation. Two things follow. A promise that fulfils after the last flush of
the process is not recorded, and the function keeps whatever TypeScript infers.
And only the Node runtimes do this; the browser collector still records a
returned promise as `Promise<unknown>`, which `apply` drops. `async` functions
are unaffected either way: TypeScript infers their promise type once the
parameters are typed.

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

ts-capture never overwrites an existing annotation (unless
[`ignoreExistingTypes`](../reference/configuration.md#scope--existing-types), a
measurement mode, is on). `const f = (x: T): U => …` keeps its `T` and `U`;
only _missing_ annotations inside it get filled.

## Observation is not side-effect free

Describing a value means reading its properties, so **getters run and `Proxy`
get-traps fire** during observation. Accessors that lazily initialize, count,
mutate, or issue requests will run more often with ts-capture loaded. See
[Observation reads your values](how-it-works.md#observation-reads-your-values--including-getters).

## Only the code paths you actually ran

Nothing warns you that a position was under-observed — it simply gets a type
derived from the calls that happened, or none at all. See
[Why runtime observation](why-runtime-observation.md#the-case-for-observing-at-runtime).

## An object shape describes the values the run saw, not the contract

This is the limit with the sharpest edge, and the one no check can catch for
you.

When ts-capture writes an object shape it is describing the objects that
actually flowed through that position. Where the position has a real contract,
that is the contract. Where it does not, it is whatever the caller happened to
pass — and if the caller was a test, the test's fixture ends up in your source.

Both of the following came from one run against a real codebase.

```ts title="The shape is the contract — correct"
protected publish(partialPacket: ReadPacket, callback) {
  // Every packet this client builds has these three fields.
  const packet: { data: string, id: string, pattern: string } =
    this.assignPacketId(partialPacket);
```

```ts title="The shape is the fixture — wrong"
for (const packageName of packageNames) {
  // `lookupPackage` returns whatever packages the user's .proto declares.
  // `test` and `test2` are the package names in the project's own test
  // .proto files, now written into the source as if they were the type.
  const grpcPkg: { test: { service: boolean }; test2?: { service: boolean } } | null =
    this.lookupPackage(grpcContext, packageName);
```

**Nothing distinguishes them automatically.** Both compile, both leave the test
suite green, both fill a position TypeScript had as `any`, and both rest on the
same amount of evidence. They have to: a suite stays green precisely because
the annotation describes what the suite does. An annotation that overfits is a
perfect description of the run — that is what makes it invisible to running the
code.

Two things that look like they would help, and do not:

- **`skipFiles`** (and its built-in `*.spec.*` / `*.test.*` default) controls
  which files get _annotated_. It does not control where the observed values
  come _from_, and this problem is the other direction: a value built in a test
  flows into a position in the source, and the annotation lands in the source.
- **Counting observations.** Requiring a shape to be seen more than once looks
  principled and is not: a value is seen once either because one arbitrary
  caller supplied it, or because the code path runs once — a config object read
  at startup, a singleton, a bootstrap payload. Those shapes are perfectly
  stable. How often code runs says nothing about whether its shape is right.

One thing that does help, where it applies: `infer.narrowParamShapes`. For a
parameter, the function body is a second witness. A function that reads
`product.sku` and `product.price` needs those two keys and nothing else, so with
the flag on the annotation says no more than that, whatever else the fixture
carried. It stops where the body passes the parameter on, returns it or stores
it, because what the rest of the program expects of the value is then out of
sight, and it says nothing about a return type or a local. Off by default, since
the narrowed shape is a different claim from the observed one: a caller passing
an object literal with more keys than the body reads gets an excess-property
error it did not have.

**What to do about it.** Read object shapes in the diff and ask "is this the
contract, or is this one caller's payload?" — a field named `foo`, or a key
that matches a fixture, answers itself. `apply --dry-run` first; see
[Review & apply safely](../how-to/review-and-apply-safely.md).

If you would rather not have the judgement call at all, the conservative
setting is to keep named types and primitives and drop shapes entirely. On the
codebase these examples come from that removed 28 of 133 annotations — including
the correct ones.

Deciding this automatically would need to know **where each observed value was
constructed**, not just what it looked like: a shape built inside a test file
has no business being written into the source. That is provenance the collector
does not record today. It would narrow the problem considerably without closing
it — a test can construct a perfectly realistic object, and a fixture is
sometimes genuinely the contract.

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
