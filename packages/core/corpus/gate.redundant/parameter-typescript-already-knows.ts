// rule: gate.redundant
// site: word
// title: TypeScript already knows
// verdict: ok
// A callback's parameter is typed by where the callback is passed. Writing the
// same type again adds nothing.

const lengths = ["a", "bb"].map((word) => word.length);
