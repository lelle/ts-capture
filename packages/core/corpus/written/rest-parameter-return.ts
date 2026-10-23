// rule: written
// site: return type
// title: What came back from a rest parameter
// verdict: ok
// Every call returned the arguments it was given, so the parameter and the
// return are the arrays the run saw.

function valuesOrNull(...values) {
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
