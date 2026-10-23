// rule: gate.erases-enum
// site: mode
// title: A name would be replaced by what it is made of
// verdict: ok
// TypeScript types this parameter as the enum `Mode`. The run only sees the
// string underneath. Writing `string` would throw the enum away, and with it
// every comparison against `Mode.Fast`.

enum Mode {
  Fast = "fast",
  Slow = "slow",
}

const modes = [Mode.Fast, Mode.Slow];
modes.forEach((mode) => mode.length);
