// rule: gate.redundant
// site: largest
// title: A variable inferred from `Math.max`
// verdict: ok
// TypeScript infers `number` from the call, which is what the run saw.

const largest = Math.max(1, 2);
