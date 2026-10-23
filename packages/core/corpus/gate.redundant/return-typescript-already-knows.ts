// rule: gate.redundant
// site: return type
// title: TypeScript already knows
// verdict: ok
// TypeScript infers `number` from the body, which is what the run saw.

function double(n: number) {
  return n * 2;
}

double(2);
