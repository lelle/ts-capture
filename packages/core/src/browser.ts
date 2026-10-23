// The part of ts-capture that runs without Node: instrument a source, observe
// it running, and apply what was seen to a project held in memory. Nothing
// here reads a disk, an environment variable or a config file.

import type {
  CollectedTypeInfo,
  CollectionContext,
  CollectorOptions,
} from "./collector-contract.js";

import { createCollectionContextWith } from "./collection-context.js";
import { createTrackedPromiseState } from "./promise-state.js";
import { createTscptrHook, type TscptrFn } from "./tscptr-hook.js";

/** Instrument a single source string with type-tracking calls. */
export { instrumentSource } from "./instrument.js";

/** Apply observations to a project read through a `ts.System`, behind the type-check gate. */
export { applyInMemory } from "./in-memory-apply.js";

/** The summary and `--report` lines the CLI prints for an apply. */
export { notWrittenLine, reportLines, summaryLines } from "./cli/apply-report.js";

/** Inference defaults, for a caller that overrides some of them. */
export { INFER_DEFAULTS } from "./configuration.js";

export type { LocatedSkip, LocatedWrite } from "./cli/apply-report.js";
export type { CollectedTypeInfo, CollectorOptions } from "./collector-contract.js";
export type { InferOptions } from "./configuration.js";
export type {
  ApplyRule,
  ApplySkip,
  ApplySkipReason,
  ApplyTelemetry,
  ApplyWrite,
} from "./contract.js";
export { APPLY_RULES } from "./contract.js";
export type { InMemoryApplyInput, InMemoryApplyResult } from "./in-memory-apply.js";
export type { TscptrFn } from "./tscptr-hook.js";

export interface Observer {
  /** Hand this to the instrumented code as `__tscptr__`. */
  hook: TscptrFn;
  context: CollectionContext;
  /**
   * What was observed, once the returned promises that settle within a turn of
   * the event loop have been read. A rejection among them is marked handled.
   */
  collect(): Promise<CollectedTypeInfo>;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function createObserver(options?: CollectorOptions): Observer {
  const context = createCollectionContextWith(createTrackedPromiseState(), options);
  return {
    hook: createTscptrHook(context),
    context,
    async collect() {
      context.settlePromises();
      await nextTurn();
      context.settlePromises();
      await nextTurn();
      return context.getCollectedTypes();
    },
  };
}
