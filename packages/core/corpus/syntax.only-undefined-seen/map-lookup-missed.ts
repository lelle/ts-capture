// rule: syntax.only-undefined-seen
// site: missing
// verdict: ok
// A lookup that missed; `: undefined` would forbid the hit TypeScript knows can happen.
const prices = new Map([["tea", 3]]);
const missing = prices.get("coffee");
