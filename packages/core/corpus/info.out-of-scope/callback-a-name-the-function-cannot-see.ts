// rule: info.out-of-scope
// site: factory
// title: A name the function cannot see
// verdict: ok
// The parameter received a class declared at the call. Its name means nothing
// where the parameter is.

function later(factory) {
  return new factory();
}

later(class Job {});
