// rule: syntax.no-site
// site: *
// apply: moved
// verdict: ok
// A line was added above after the run, so every recorded position is a line off.
function greet(user) {
  return "Hello " + user.name;
}

greet({ name: "Ada" });
