// rule: syntax.one-branch-seen
// site: label
// title: A field where `??` only gave its left side
// verdict: ok
// The initializer can give either side of `??`, and the run only ever saw one.
// Writing what it saw would forbid the other, so the type is left to
// TypeScript.

const labels = ["a", "b"];

class Badge {
  label = labels.find((l) => l === "a") ?? "none";
}

new Badge();
