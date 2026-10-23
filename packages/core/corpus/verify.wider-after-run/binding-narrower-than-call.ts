// rule: verify.wider-after-run
// site: fromNull
// verdict: ok
// The run saw `null[]`, but once `valuesOrNull` has its return type TypeScript
// infers the wider array, which holds what the run saw.
function valuesOrNull(...values) {
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
const fromNull = valuesOrNull(null);
