// rule: syntax.as-const
// site: sizes
// title: An array `as const`
// verdict: ok
// `as const` makes the array a readonly tuple of its literals. What the run saw
// can only be wider, so writing it would undo what the author asked for.

const sizes = ["s", "m"] as const;
