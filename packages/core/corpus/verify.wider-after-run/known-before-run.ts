// rule: verify.wider-after-run
// site: return type
// title: A branch the tests never took, already known
// verdict: ok
// The tests never took `return null`, so the run saw only the object.
// TypeScript inferred `{ id: number } | null` before the run already, so
// writing it would only repeat it.

function findUser(id: number) {
  if (id < 0) return null;
  return { id };
}

findUser(1);
