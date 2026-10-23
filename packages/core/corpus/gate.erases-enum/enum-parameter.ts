// rule: gate.erases-enum
// site: mode
// verdict: ok
// TypeScript has the enum `Mode`; the run sees only the string beneath it.
enum Mode {
  Fast = "fast",
  Slow = "slow",
}

const modes = [Mode.Fast, Mode.Slow];
modes.forEach((mode) => mode.length);
