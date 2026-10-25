// rule: gate.redundant
// site: cond
// title: A callback whose type names a generic with defaults
// verdict: ok
// `cond` gets its type from `conditions`, and the run saw the same. TypeScript
// spells it `(c: Context<any, any>) => boolean` away from the code and
// `(c: Context) => boolean` where `cond` is, so it is the type TypeScript has.

interface Context<Env = any, Path extends string = any> {
  env: Env;
  path: Path;
}

function matchesAny(...conditions: ((c: Context) => boolean)[]) {
  return (c: Context) => conditions.some((cond) => cond(c));
}

matchesAny((c: Context) => c.path === "/")({ env: {}, path: "/" });
