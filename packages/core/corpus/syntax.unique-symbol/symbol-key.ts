// rule: syntax.unique-symbol
// site: key
// title: A `unique symbol` would become any symbol
// verdict: ok
// TypeScript types `Symbol("key")` in a `const` as a `unique symbol`, which can
// key a type. The run only sees a symbol. Writing `symbol` would widen it.

const key = Symbol("key");
