// rule: gate.discards-union-arm
// site: fromNull
// verdict: questionable
// Reported as kept-existing, while the same binding without the `return null`
// branch is left to TypeScript (see verify.wider-after-run). Both observed less
// than TypeScript infers; they differ only in which rule noticed first.
function valuesOrNull(...values) {
  if (!values[0]) {
    return null;
  }
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
const fromNull = valuesOrNull(null);
