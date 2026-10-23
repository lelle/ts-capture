// rule: gate.redundant
// site: task
// title: TypeScript already knows
// verdict: ok
// The array's type says what each element is, so TypeScript types the
// callback's parameter already.

const tasks = [() => 1];
tasks.forEach((task) => task());
