// rule: syntax.outer-conflict
// site: boxed
// title: Inside a generic function
// verdict: ok
// The run saw one call, with a number. Inside the function the value is a `T`,
// which stands for every type a caller can pass, so writing `number` would be
// wrong for the others.

function wrap<T>(value: T) {
  const boxed = { value };
  return boxed;
}

wrap(1);
