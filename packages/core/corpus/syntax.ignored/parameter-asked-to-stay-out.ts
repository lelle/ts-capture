// rule: syntax.ignored
// site: input
// title: Asked to stay out
// verdict: ok
// A `@ts-capture-ignore` comment above a declaration keeps apply away from all
// of it.

// @ts-capture-ignore
function parse(input) {
  return JSON.parse(input);
}

parse('{"a":1}');
