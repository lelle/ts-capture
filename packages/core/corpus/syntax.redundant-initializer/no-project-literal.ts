// rule: syntax.redundant-initializer
// site: count
// title: Without a project, read from the initializer
// apply: no-project
// verdict: questionable
// With no tsconfig there is no type checker, so whether TypeScript would infer
// the same type is read from the initializer itself: `0` is a number. With a
// project, the checker answers first.

let count = 0;
count += 1;
