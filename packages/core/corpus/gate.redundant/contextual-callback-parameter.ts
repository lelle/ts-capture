// rule: gate.redundant
// site: word
// verdict: ok
// `map` already types the callback's parameter as `string`.
const lengths = ["a", "bb"].map((word) => word.length);
