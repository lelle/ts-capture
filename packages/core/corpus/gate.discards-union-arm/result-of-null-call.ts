// rule: gate.discards-union-arm
// site: fromNull
// title: Only `null` back from a call that can return an array
// verdict: ok
// The tests only ever got `null` back here, but TypeScript knows the call can
// also return the array. Writing `null` would forbid the array, so the type is
// left to TypeScript, which already holds both.

function valuesOrNull(...values) {
  if (!values[0]) {
    return null;
  }
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
const fromNull = valuesOrNull(null);
