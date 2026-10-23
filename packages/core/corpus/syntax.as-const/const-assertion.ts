// rule: syntax.as-const
// site: sizes
// verdict: ok
// `as const` asks for the narrow type; an observation can only widen it.
const sizes = ["s", "m"] as const;
