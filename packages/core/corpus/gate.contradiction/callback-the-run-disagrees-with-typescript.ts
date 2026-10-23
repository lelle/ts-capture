// rule: gate.contradiction
// site: next
// title: The run disagrees with TypeScript
// verdict: ok
// TypeScript types `next` from the signature the callback is assigned to: a
// function, never missing. The run passed `undefined` once. Apply reports the
// disagreement instead of widening the parameter.

const step: (go: () => void) => void = (next) => next?.();

step(() => {});
step(undefined as unknown as () => void);
