// rule: syntax.one-branch-seen
// site: label
// verdict: ok
// The run saw one side of `??`; writing it would forbid the other.
const words = ["a", "b"];
const label = words.find((w) => w === "a") ?? "none";
