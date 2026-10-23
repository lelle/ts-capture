// rule: syntax.already-typed
// site: clock
// title: A type is written already
// apply: twice
// verdict: ok
// The same observations applied a second time meet the type the first apply
// wrote. Apply never replaces a type that is there, its own or anyone else's.

function stamp(clock) {
  clock();
}

stamp(() => new Date());
