// rule: written
// site: return type
// verdict: ok
// Every call returned the array it was given; TypeScript knew nothing before the run.
function valuesOrNull(...values) {
  return values;
}
valuesOrNull(1, 2);
valuesOrNull("1", 2);
