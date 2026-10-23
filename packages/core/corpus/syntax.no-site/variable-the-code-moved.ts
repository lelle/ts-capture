// rule: syntax.no-site
// site: data
// title: A variable moved down a line
// apply: moved
// verdict: ok
// A line was added above the code after the run. Every recorded position now
// points one line too early, at no variable, so apply writes nothing there and
// says so.

const data = JSON.parse('{"id": 1}');
