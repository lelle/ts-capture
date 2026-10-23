// rule: verify.type-error
// site: return type
// verdict: ok
// Every call the run saw returned a number, but `label` hands the result on as
// a `string`. Written, `number` would make that line an error.
function parse(text) {
  return JSON.parse(text);
}

parse("1");

function label(): string {
  return parse('"a"');
}
