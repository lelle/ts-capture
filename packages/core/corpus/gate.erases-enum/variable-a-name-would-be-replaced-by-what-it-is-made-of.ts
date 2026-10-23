// rule: gate.erases-enum
// site: mode
// title: A variable holding an enum member
// verdict: ok
// TypeScript infers the enum `Mode`. The run only sees the string underneath,
// and writing `string` would throw the enum away.

enum Mode {
  Fast = "fast",
  Slow = "slow",
}

const mode = [Mode.Fast, Mode.Slow][0];
