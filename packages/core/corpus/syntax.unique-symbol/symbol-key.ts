// rule: syntax.unique-symbol
// site: key
// verdict: ok
// TypeScript infers `unique symbol`; writing `symbol` would widen it.
const key = Symbol("key");
