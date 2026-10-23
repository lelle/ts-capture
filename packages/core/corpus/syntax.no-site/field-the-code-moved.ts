// rule: syntax.no-site
// site: items
// title: A field moved down a line
// apply: moved
// verdict: ok
// A line was added above the code after the run. Every recorded position now
// points one line too early, at no field, so apply writes nothing there and
// says so.

class Store {
  items = JSON.parse("[1, 2]");
}

new Store();
