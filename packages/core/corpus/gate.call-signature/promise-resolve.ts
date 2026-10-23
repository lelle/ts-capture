// rule: gate.call-signature
// site: resolve
// verdict: ok
// The run can only say `resolve` was callable; TypeScript has its signature.
const ready = new Promise((resolve) => resolve(1));
