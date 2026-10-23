// rule: gate.contradiction
// site: return type
// verdict: ok
// TypeScript reads the return as `string`; the run got `undefined`. Reported, not written.
function nameOf(user: { name: string }) {
  return user.name;
}

nameOf(JSON.parse("{}"));
