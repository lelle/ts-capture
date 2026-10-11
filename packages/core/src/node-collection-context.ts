import { inspect } from "node:util";

import type { CollectionContext, CollectorOptions } from "./collector-contract.js";
import type { PromiseState } from "./promise-state.js";

import { createCollectionContextWith } from "./collection-context.js";

export function createCollectionContext(options?: CollectorOptions): CollectionContext {
  return createCollectionContextWith(inspectPromiseState, options);
}

/**
 * A promise's state without touching it. `util.inspect` reads it off the
 * engine, where `then` would register a reaction and mark a rejection handled.
 */
function inspectPromiseState(promise: Promise<unknown>): PromiseState {
  const text = inspect(promise, {
    depth: 0,
    maxStringLength: 0,
    maxArrayLength: 0,
    breakLength: Infinity,
    colors: false,
  });
  const state = /^[^{]*\{\s*<(pending|rejected)>/.exec(text);
  return state ? (state[1] as "pending" | "rejected") : "fulfilled";
}
