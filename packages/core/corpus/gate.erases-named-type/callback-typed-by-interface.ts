// rule: gate.erases-named-type
// site: user
// title: A name would be replaced by what it is made of
// verdict: ok
// TypeScript types `user` as the interface `User` from where the callback is
// passed. The run saw a shape with one more field. Writing that shape would
// throw the name `User` away, and with it everything the interface says.

interface User {
  name: string;
}

function each(visit: (user: User) => void) {
  visit({ name: "Ada", age: 36 } as User);
}

each((user) => user.name);
