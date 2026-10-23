// rule: gate.contradiction
// site: word
// title: A field read one past the end of an array
// verdict: ok
// TypeScript types an element of a `string[]` as `string`. The second instance
// read one past the end, so the run saw `undefined` too.

const words = ["a"];
let next = 0;

class Slot {
  word = words[next++];
}

new Slot();
new Slot();
