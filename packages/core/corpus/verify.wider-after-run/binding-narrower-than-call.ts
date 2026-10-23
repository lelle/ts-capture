// rule: verify.wider-after-run
// site: fromNull
// title: Narrower than the call it came from
// verdict: ok
// This call returned `null[]`. Once `valuesOrNull` has its return type,
// TypeScript infers the wider array for the variable, and that holds what the
// run saw. Writing `null[]` would only narrow it.

function valuesOrNull(...values) {
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
const fromNull = valuesOrNull(null);
