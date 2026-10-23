// rule: written
// site: return type
// title: What came back, where TypeScript knows nothing
// real: params-and-return
// verdict: ok
// The function hands back an element of a parameter TypeScript has no type for,
// so it infers `any`. The run saw what actually came back.

function first(list) {
  return list[0];
}

first([{ id: 1, name: "Ada" }]);
