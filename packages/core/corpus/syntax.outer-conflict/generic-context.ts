// rule: syntax.outer-conflict
// site: boxed
// verdict: ok
// Inside a generic function the run saw one instantiation; `T` covers them all.
function wrap<T>(value: T) {
  const boxed = { value };
  return boxed;
}

wrap(1);
