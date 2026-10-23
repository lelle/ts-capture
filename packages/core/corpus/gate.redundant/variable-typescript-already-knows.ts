// rule: gate.redundant
// site: largest
// title: TypeScript already knows
// verdict: ok
// TypeScript infers `number` from the call, which is what the run saw.

const largest = Math.max(1, 2);
