// rule: syntax.already-typed
// site: user
// apply: twice
// verdict: ok
// The second apply meets the type the first wrote, and never replaces a type.
function greet(user) {
  return "Hello " + user.name;
}

greet({ name: "Ada" });
