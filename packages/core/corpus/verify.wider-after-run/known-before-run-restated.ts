// rule: verify.wider-after-run
// site: return type
// title: The same, with restatements asked for
// infer: skipRedundantAnnotations=false
// verdict: ok
// With `skipRedundantAnnotations` off, apply writes types TypeScript already
// infers. That includes this return, as TypeScript has it.

function findUser(id: number) {
  if (id < 0) return null;
  return { id };
}

findUser(1);
