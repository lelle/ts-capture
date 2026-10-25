// rule: gate.redundant
// site: cond
// title: A callback whose type is a function alias
// verdict: ok
// `cond` gets its type from `conditions`, which TypeScript prints by the alias
// name `Condition`. The run saw the alias's body, `(c: Context) => boolean`:
// the same type, so there is nothing to write.

interface Context {
  path: string;
}

type Condition = (c: Context) => boolean;

function matchesAny(...conditions: Condition[]) {
  return (c: Context) => conditions.some((cond) => cond(c));
}

matchesAny((c: Context) => c.path === "/")({ path: "/" });
