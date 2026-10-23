// rule: written
// site: user
// title: What every call passed
// real: params-and-return, callback, untyped-collection, named-type
// verdict: ok
// The run saw one shape at this parameter, and nothing in TypeScript already
// says more.

function greet(user) {
  return "Hello " + user.name;
}

greet({ name: "Ada" });
greet({ name: "Bo" });
