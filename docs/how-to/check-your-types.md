# Check the types you wrote

Goal: find the parameters and return types whose written type disagrees with
what your tests actually pass in and get back. Nothing in your source changes.

```ts
export function addToCart(cart: Cart, sku: string, qty: string, unitPrice: number): Cart { … }
// the tests call addToCart(cart, "apple", 2, 1.5)
```

```text title="Current"
Written types (21 checked)
src/cart.ts:17:52  qty
  declared  string
  observed  number
  18 match, 1 mismatch, 2 unverifiable, 0 without a declaration.
  unverifiable: 1 literal declared type, 1 declared any

Inferred types (9 checked)
  8 match, 0 mismatch, 1 unverifiable, 0 without a declaration.
  unverifiable: 1 declared any
```

It works with any setup that already collects types: [Vite / Vitest](use-with-vite-vitest.md),
[Jest (Babel)](use-with-jest-babel.md), [Svelte](use-with-svelte.md) or
[no bundler](use-without-a-bundler.md).

## What is checked

- Parameters and return types that have a written type; a destructured
  parameter is compared as a whole. Variables and class fields are not
  checked yet.
- Only a value outside the written type is a mismatch. A type wider than what
  ran is a match: `string | null` that only ever saw a `string` is not
  reported, because the tests may simply not reach the `null`.
- An async return is compared with what its promise resolved to.

`apply` never writes over a type you wrote, so running the check and applying
from the same observations is safe.

## Run the tests with the variable

Set `TS_CAPTURE_OBSERVE_ANNOTATED=1` in the process that instruments the code.
For Vitest and Jest that is the test command; for a Vite dev server it is the
shell that starts the server. Use a directory of its own, so the check does
not mix with observations from earlier runs.

```sh
TS_CAPTURE_OBSERVE_ANNOTATED=1 TS_CAPTURE_TYPES_DIR=./.ts-capture-check npx vitest run
```

With Jest, add `--no-cache` the first time you switch the variable on or off.
Jest caches transformed files, and the variable is not part of its cache key,
so it would otherwise reuse files instrumented without it:

```sh
TS_CAPTURE_OBSERVE_ANNOTATED=1 TS_CAPTURE_TYPES_DIR=./.ts-capture-check npx jest --no-cache
```

## Merge and verify

```sh
npx ts-capture merge ./.ts-capture-check --out types.json
npx ts-capture verify types.json --project tsconfig.json
```

The written types come first, each mismatch with its location, then the
positions without a type, where `verify` compares with what TypeScript
infers. If `verify` says no written types were observed, the variable did not
reach the process that instrumented the code (or Jest used its cache).

## Read a mismatch

A mismatch says a value the tests produced is outside the type. Either the
type is too narrow (`qty: string` while every caller passes a number), or a
test passes something the code was never meant to get. `verify` cannot tell
which; the location takes you to the line to decide.

_Unverifiable_ means the comparison would be a guess, and the line under the
totals says why. The common reasons are `declared any` and `declared unknown`,
which every value fits; `literal declared type`, such as `"GET" | "POST"`,
which the run records as `string`; `generic declared type`, a type parameter
or a type built on one, which a run cannot pin down; and `declared narrower
than observable`, such as a brand the runtime value does not carry. Interfaces,
aliases and classes are compared by TypeScript and are mostly settled. On hono
and nest about a fifth of the written types end up here. A high count is a
limit of the check, not a sign that your types are right.

## Fail CI on a mismatch

```sh
npx ts-capture verify types.json --project tsconfig.json --threshold=1
```

With written types observed, `--threshold` counts only them: `1` fails the
build on any mismatch in a type you wrote, while the inferred positions are
still printed but do not count. Unverifiable positions count neither way. See
the [CLI reference](../reference/cli.md#ts-capture-verify-typesjson---project-tsconfigjson---thresholdn).
