# JSX element typing — the React special-case and the non-React boundary

Status: **intentional / settled.** This note records why `core` emits
`React.ReactElement` for observed JSX elements, why React is the one UI
library `core` hardcodes, and what happens for other JSX frameworks
(SolidJS, Vue-JSX, Qwik, native Preact). It is not a backlog item; it
documents a deliberate scope boundary so it isn't mistaken for a gap.

## Current behavior — brand-based, not library-based

`core` detects a React element by its self-applied **brand**, not by
detecting the React library. `value-walker.ts:isReactElement` checks that
the value carries a `$$typeof` symbol whose description starts with
`"react."` (`react.element` pre-19, `react.transitional.element` in 19+).
When it matches, the walker emits the public type name `React.ReactElement`
instead of walking the element's internal `FiberNode` / `_owner` / `_store`
shape (which would leak React's private types and get the whole annotation
rejected by `allTypeRefsInScope`).

```ts title="Input"
// Observed at runtime: a value with $$typeof === Symbol.for("react.element")
function Layout(slot) {
  return slot;
}
Layout(<div>hi</div>);
```

```ts title="Expected"
function Layout(slot: React.ReactElement) {
  return slot;
}
Layout(<div>hi</div>);
```

`React.ReactElement` resolves **without an explicit import**: `@types/react`
declares `export as namespace React` (a UMD global). `scope-reachability.ts`
mirrors this by adding `React` to the in-scope type names only for
`.tsx` / `.jsx` targets — so on a plain `.ts` file an emitted
`React.ReactElement` is correctly judged out-of-scope and dropped.

## Why React is the one library `core` hardcodes

The walker's layering forbids library-specific knowledge: it never imports
`typescript` or any framework, and `collector-contract ← type-signature ←
value-walker ← collection-context` imports strictly downward. React is the
single exception, justified by a combination no other framework shares:

- **A stable, ubiquitous runtime brand** (`$$typeof`) spanning React 18 and
  19+, detectable without a constructor check.
- **A JSX element type that resolves with no import** (the UMD global).
  Every other framework's canonical type (`solid-js`'s `JSX.Element`,
  Vue's `VNode`) requires an explicit import — emitting it would mean
  _injecting an import_, not just an annotation.

Because detection keys on the brand ("this value claims to be a react
element"), it is also correct for **preact/compat**, which intentionally
brands its vnodes as `react.element` and types against the React types.

## Non-React JSX: safe, but unsupported on this path

Values from SolidJS, Vue-JSX, Qwik, and native (non-compat) Preact do **not**
carry a `react.*` brand, so they never match `isReactElement` and are never
mislabeled as `React.ReactElement`. They fall through to the structural
walk, which usually yields a type `allTypeRefsInScope` rejects, so the
position is left untouched.

```tsx title="Input"
// SolidJS: JSX compiles to a real DOM node; the observed value is an
// HTMLElement, with no framework brand to detect.
function Panel(body) {
  return body;
}
Panel(<div>hi</div>);
```

```tsx title="Expected"
// No annotation emitted. NOT mislabeled as React.ReactElement — the value
// has no react.* brand. (Solid is the hardest case: JSX -> DOM means there
// is no "Solid element" object to observe at runtime at all.)
function Panel(body) {
  return body;
}
Panel(<div>hi</div>);
```

This is the safe failure mode: a missed annotation, never a wrong one.

## If we ever generalize

The right shape is **not** more hardcoded `brand → string` branches in the
walker — that violates the layering above and adds dispatch on the runtime
hot path. It is a deferred pluggable `TypeResolver` registry: each
special case (peek, React, iterators, class-hierarchy) becomes a registered
strategy, with a per-framework emit name + required scope import, gated
behind the TypeChecker path so resolvability can be verified.

The extension mechanism already exists and is in production use: the
`Symbol.for("ts-capture.peek")` protocol lets a framework adapter expose an
unwrapped value without `core` knowing its sigils — `@ts-capture/svelte`
uses it today (`packages/svelte/src/runes.ts`). Peek covers "unwrap this
value"; a JSX-element resolver would additionally need "name this as the
framework's element type + ensure that name is importable." Revisit only
when a second external resolver consumer (Vue / Solid / etc.) is real.
