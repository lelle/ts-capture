// rule: syntax.redundant-initializer
// site: count
// apply: no-project
// verdict: questionable
// Without a tsconfig there is no checker, so redundancy is read from the
// initializer's syntax instead. With a project the gate always answers first,
// as `gate.redundant`; this rule is reached only without one.
let count = 0;
count += 1;
