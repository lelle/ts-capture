// rule: syntax.one-branch-seen
// site: label
// title: A variable where `??` only gave its left side
// verdict: ok
// The initializer can give either side of `??`, and the run only ever saw one.
// Writing what it saw would forbid the other, so the type is left to
// TypeScript, which knows both.

const words = ["a", "b"];
const label = words.find((w) => w === "a") ?? "none";
