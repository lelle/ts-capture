// rule: gate.contradiction
// site: word
// title: A `string` callback parameter given `undefined`
// verdict: ok
// TypeScript already types this callback parameter as `string`, but the run
// passed `undefined` too. Apply does not write a type the checker contradicts;
// it reports the disagreement instead.

function each(words: string[], visit: (value: string) => void) {
  for (const word of words) visit(word);
}

const words = ["a", "b"];
words.push(undefined as unknown as string);
each(words, (word) => word);
