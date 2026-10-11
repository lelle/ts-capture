export type PromiseState = "fulfilled" | "pending" | "rejected";

export type PromiseStateReader = (promise: Promise<unknown>) => PromiseState;

/**
 * A reader for runtimes that cannot inspect a promise: it follows each promise
 * from the first time it is asked about it, and answers `pending` until then.
 * Following a promise registers a reaction, so a rejection it has seen is no
 * longer reported as unhandled.
 */
export function createTrackedPromiseState(): PromiseStateReader {
  const states = new WeakMap<Promise<unknown>, PromiseState>();
  return (promise) => {
    const known = states.get(promise);
    if (known) return known;
    states.set(promise, "pending");
    promise.then(
      () => states.set(promise, "fulfilled"),
      () => states.set(promise, "rejected"),
    );
    return "pending";
  };
}
