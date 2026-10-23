// rule: verify.wider-after-run
// site: return type
// verdict: ok
// The run never took the `return null` branch, so the observed return leaves
// out `null` and fails to compile. Once `values` is written, TypeScript infers a
// type that holds every value the run saw, and that is written instead, spelled
// as apply spells its own. See known-before-run for a return TypeScript already
// inferred before the run.
function valuesOrNull(...values) {
  if (!values[0]) {
    return null;
  }
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
const fromNull = valuesOrNull(null);
