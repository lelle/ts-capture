// rule: verify.type-error
// site: return type
// title: A caller the tests never ran
// verdict: ok
// Every call returned a number, so that is what the run saw. But `label` hands
// the result on as a `string`, and written, the type would make that line an
// error.

function parse(text) {
  return JSON.parse(text);
}

parse("1");

function label(): string {
  return parse('"a"');
}
