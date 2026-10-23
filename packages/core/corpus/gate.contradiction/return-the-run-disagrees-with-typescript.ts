// rule: gate.contradiction
// site: return type
// title: The run disagrees with TypeScript
// verdict: ok
// TypeScript reads the return as `string` from the parameter's type. The run
// got `undefined`, because a test passed an object without the field. Apply
// reports that instead of writing either.

function nameOf(user: { name: string }) {
  return user.name;
}

nameOf(JSON.parse("{}"));
