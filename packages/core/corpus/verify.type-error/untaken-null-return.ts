// rule: verify.type-error
// site: return type
// verdict: questionable
// The run never took the `return null` branch, so the observed return leaves
// out `null` and fails to compile. TypeScript infers
// `(string | number | null)[] | null` once `values` is written, which holds
// every value the run saw.
function valuesOrNull(...values) {
  if (!values[0]) {
    return null;
  }
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
const fromNull = valuesOrNull(null);
