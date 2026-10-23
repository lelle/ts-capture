# A `unique symbol` would become any symbol

TypeScript infers a `unique symbol` for a `const` holding `Symbol()`. The run only sees a symbol, and writing `symbol` would widen it.
