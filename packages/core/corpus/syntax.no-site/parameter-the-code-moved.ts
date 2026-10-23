// rule: syntax.no-site
// site: user
// title: The code moved
// apply: moved
// verdict: ok
// A line was added above the code after the run. Every recorded position now
// points one line too early, at no parameter, so apply writes nothing there and
// says so.

function greet(user) {
  return "Hello " + user.name;
}

greet({ name: "Ada" });
