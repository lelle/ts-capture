// rule: gate.erases-enum
// site: mode
// title: A name would be replaced by what it is made of
// verdict: ok
// TypeScript infers the enum `Mode`. The run only sees the string underneath,
// and writing `string` would throw the enum away.

enum Mode {
  Fast = "fast",
  Slow = "slow",
}

class Runner {
  mode = [Mode.Fast, Mode.Slow][0];
}

new Runner();
