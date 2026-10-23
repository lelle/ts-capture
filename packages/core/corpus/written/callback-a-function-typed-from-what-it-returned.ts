// rule: written
// site: clock
// title: A function, typed from what it returned
// real: callback
// verdict: ok
// The parameter received a function. The run saw it called and saw what came
// back, so it is written as a function type.

function stamp(clock) {
  return clock().getTime();
}

stamp(() => new Date());
