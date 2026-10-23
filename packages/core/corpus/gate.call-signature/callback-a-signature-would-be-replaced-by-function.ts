// rule: gate.call-signature
// site: resolve
// title: The `resolve` a promise hands its executor
// verdict: ok
// `resolve` is a function the engine made, so the run can only say it was
// callable. TypeScript already has its signature, and `Function` would throw
// that away.

const ready = new Promise((resolve) => resolve(1));
