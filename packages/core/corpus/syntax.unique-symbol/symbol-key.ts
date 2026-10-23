// rule: syntax.unique-symbol
// site: key
// title: `Symbol("key")` in a `const`
// verdict: ok
// TypeScript types `Symbol("key")` in a `const` as a `unique symbol`, which can
// key a type. The run only sees a symbol. Writing `symbol` would widen it.

const key = Symbol("key");
