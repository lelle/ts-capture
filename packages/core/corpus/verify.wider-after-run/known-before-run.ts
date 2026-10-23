// rule: verify.wider-after-run
// site: return type
// verdict: ok
// The run never took `return null`. TypeScript inferred `{ id: number } | null`
// before the run already, so writing it would only restate it.
function findUser(id: number) {
  if (id < 0) return null;
  return { id };
}

findUser(1);
