// rule: syntax.ignored
// site: return type
// title: Asked to stay out
// verdict: ok
// A `@ts-capture-ignore` comment above a declaration keeps apply away from all
// of it.

// @ts-capture-ignore
function load(text) {
  return JSON.parse(text);
}

load('{"a":1}');
