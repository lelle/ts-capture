// rule: gate.contradiction
// site: word
// title: The run disagrees with TypeScript
// real: conflict-note
// verdict: ok
// TypeScript types an element of a `string[]` as `string`. The loop read one
// past the end, so the run saw `undefined` too. Apply reports the disagreement
// instead of writing either.

const words = ["a"];
for (const i of [0, 1]) {
  const word = words[i];
}
