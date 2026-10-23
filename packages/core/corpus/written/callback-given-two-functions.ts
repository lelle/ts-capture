// rule: written
// site: produce
// verdict: ok
// Each call passed a different function, so the parameter accepts either.
function resultOf(produce) {
  return produce();
}
resultOf(() => 1);
resultOf(() => "one");
