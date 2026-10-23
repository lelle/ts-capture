// rule: gate.erases-named-type
// site: user
// verdict: ok
// TypeScript types `user` as `User`; the run saw a wider shape, and writing it
// would throw the name away.
interface User {
  name: string;
}

function each(visit: (user: User) => void) {
  visit({ name: "Ada", age: 36 } as User);
}

each((user) => user.name);
