// rule: syntax.only-undefined-seen
// site: missing
// title: A `Map` lookup that missed
// verdict: ok
// The lookup missed, so the run saw `undefined` alone. TypeScript knows the
// lookup can also hit. Writing `undefined` would forbid that, so the type is
// left to TypeScript.

const prices = new Map([["tea", 3]]);
const missing = prices.get("coffee");
