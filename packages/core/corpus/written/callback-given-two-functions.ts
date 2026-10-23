// rule: written
// site: produce
// title: Different functions at each call
// verdict: ok
// One call passed a function returning a number, the other one returning a
// string. The parameter accepts either.

function resultOf(produce) {
  return produce();
}
resultOf(() => 1);
resultOf(() => "one");
