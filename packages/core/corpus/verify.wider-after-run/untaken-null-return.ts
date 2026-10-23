// rule: verify.wider-after-run
// site: return type
// title: A branch the tests never took
// verdict: ok
// The tests never took the `return null` branch, so what the run saw would not
// compile with it. Once `values` is written, TypeScript infers a type that
// holds every value the run saw, and that is what is written.

function valuesOrNull(...values) {
  if (!values[0]) {
    return null;
  }
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
const fromNull = valuesOrNull(null);
