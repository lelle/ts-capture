# Why runtime observation

Most type tools work statically — they read your source and reason about it.
ts-capture instead **watches your code run** and records the types values
actually had. This is a deliberate trade-off, and it determines where the tool
helps and where it doesn't.

## The case for observing at runtime

A static tool can only infer what the source already constrains. The hardest
`any`s — a parameter no annotation pins down, a callback argument, a
`JSON.parse` result — are exactly the ones static inference gives up on, because
the information isn't in the source. It _is_ in the runtime: the value that
actually flowed through. ts-capture reads it there.

The approach isn't new:
[TypeWiz](https://github.com/mockdeep/typewiz) (archived 2021) pioneered
runtime type collection for TypeScript and directly inspired ts-capture.

The cost is that observation needs real executions (usually your test suite) and
adds run-time overhead — see [Performance](../../README.md#performance). The
payoff is types for positions a static tool leaves as `any`.

The deeper consequence of that trade-off: **the output is a function of which
code paths ran**, not of the code itself. A static tool gives the same answer
every time; ts-capture gives the answer your last run earned, so two different
test selections produce different annotations and neither is wrong. Apply from a
run that represents how the code is really used, and re-observe after
meaningfully expanding the suite. Reading your values also has real side effects
— see
[Observation reads your values](how-it-works.md#observation-reads-your-values--including-getters).

## When ts-capture helps most

- **Untyped or partially-typed code** — its primary value is filling implicit
  `any` on parameters, locals, and callback arguments. The more implicit `any`
  you have, the more it can do.
- **TS migrations in progress** — freshly-converted files have untyped params
  and locals; ts-capture fast-tracks the param/return inference.
- **Callback-heavy code** — `.replace((m, i) => ...)`, array methods, event
  handlers. These are typically `any` even in strict projects, and ts-capture
  infers them well from observed call data.

## When ts-capture helps least

- **Already fully-typed code** — it respects existing annotations and won't
  overwrite them; there's nothing to fill in.
- **Library public API surfaces** — types inferred from one test run may be
  narrower than the real contract (e.g. `string` where `string | URL` is
  intended). Review `apply --dry-run` carefully.
- **Generic-heavy code** — observed unions are flattened: a function called with
  `string` and `number` becomes `(x: string | number)`, not `<T>(x: T)`. See
  [What it cannot infer](what-it-cannot-infer.md).

For codebases already strictly typed end-to-end, the value is smaller and the
regression risk higher — read [What it cannot infer](what-it-cannot-infer.md)
and [Review & apply safely](../how-to/review-and-apply-safely.md) before running
`apply` on production code.
