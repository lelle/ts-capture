// rule: info.describes-nothing
// site: return type
// verdict: ok
// All that came back was `{}`, which says nothing about what the function returns.
function parse(text) {
  return JSON.parse(text);
}

parse("{}");
