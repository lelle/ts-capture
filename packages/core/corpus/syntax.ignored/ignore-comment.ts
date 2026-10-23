// rule: syntax.ignored
// site: input
// verdict: ok
// A `@ts-capture-ignore` comment keeps apply away from the whole declaration.
// @ts-capture-ignore
function parse(input) {
  return JSON.parse(input);
}

parse('{"a":1}');
