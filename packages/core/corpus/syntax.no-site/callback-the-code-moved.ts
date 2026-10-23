// rule: syntax.no-site
// site: clock
// title: The code moved
// apply: moved
// verdict: ok
// A line was added above the code after the run. Every recorded position now
// points one line too early, at no parameter, so apply writes nothing there and
// says so.

function stamp(clock) {
  clock();
}

stamp(() => new Date());
