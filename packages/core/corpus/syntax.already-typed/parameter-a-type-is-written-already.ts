// rule: syntax.already-typed
// site: user
// title: A parameter typed by the first apply
// apply: twice
// verdict: ok
// The same observations applied a second time meet the type the first apply
// wrote. Apply never replaces a type that is there, its own or anyone else's.

function greet(user) {
  return "Hello " + user.name;
}

greet({ name: "Ada" });
