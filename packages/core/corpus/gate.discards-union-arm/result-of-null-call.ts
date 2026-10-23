// rule: gate.discards-union-arm
// site: fromNull
// verdict: ok
// The run saw only `null`; TypeScript has the array as well. Left to TypeScript,
// as the same binding without the `return null` branch is (see
// verify.wider-after-run); the rule says which check noticed.
function valuesOrNull(...values) {
  if (!values[0]) {
    return null;
  }
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
const fromNull = valuesOrNull(null);
