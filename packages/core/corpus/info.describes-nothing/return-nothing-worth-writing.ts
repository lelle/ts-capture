// rule: info.describes-nothing
// site: return type
// title: A function that returned an empty object
// verdict: ok
// All that came back was an empty object, which says nothing about what the
// function returns.

function parse(text) {
  return JSON.parse(text);
}

parse("{}");
