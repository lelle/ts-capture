// rule: verify.wider-after-run
// site: return type
// infer: skipRedundantAnnotations=false
// verdict: ok
// The same function, with restatements asked for: TypeScript's type is written,
// as `double(n: number): number` would be.
function findUser(id: number) {
  if (id < 0) return null;
  return { id };
}

findUser(1);
