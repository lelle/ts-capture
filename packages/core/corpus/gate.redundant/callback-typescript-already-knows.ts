// rule: gate.redundant
// site: task
// title: A callback over an array of functions
// verdict: ok
// The array's type says what each element is, so TypeScript types the
// callback's parameter already.

const tasks = [() => 1];
tasks.forEach((task) => task());
