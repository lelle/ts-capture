// rule: gate.erases-enum
// site: return type
// title: A name would be replaced by what it is made of
// verdict: ok
// TypeScript infers the enum `Mode`. The run only sees the string underneath,
// and writing `string` would throw the enum away.

enum Mode {
  Fast = "fast",
  Slow = "slow",
}

function pick(quick) {
  return quick ? Mode.Fast : Mode.Slow;
}

pick(true);
