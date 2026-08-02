// --- Types ---
//
// The public type contract lives in `collector-contract.ts`. It is imported
// here for internal use and re-exported below so every existing importer
// (`index.ts`, `loader.ts`, `cli.ts`, the appliers, `@ts-capture/vite`, …)
// keeps resolving the same `./type-collector.js` path.
import type {
  CollectedTypeEntry,
  CollectedTypeInfo,
  CollectionContext,
  CollectorOptions,
  Diagnostic,
  ExtraOptions,
  LiteralOptions,
  SourceLocation,
} from "./collector-contract.js";

export type {
  CollectedTypeEntry,
  CollectedTypeInfo,
  CollectionContext,
  CollectorOptions,
  Diagnostic,
  ExtraOptions,
  LiteralOptions,
  SourceLocation,
};

// --- Signature algebra ---
//
// The pure type-string algebra lives in `type-signature.ts`. The two
// publicly-tested entry points are re-exported so importers of
// `./type-collector.js` (and type-collector.spec.ts) are untouched.
export { applyParamReturnUpgrade, upgradeObjectMemberFn } from "./type-signature.js";

// --- Value walker ---
//
// The recursive runtime-value walker lives in `value-walker.ts`.
// `getTypeName` / `wasDepthExceeded` below are back-compat shims over
// `createValueWalker`; callers that want the walker import it from
// `./value-walker.js` directly.
import { createValueWalker } from "./value-walker.js";

// --- getTypeName (back-compat shim over createValueWalker) ---

// Quarantined read-after-call cache. The walker is referentially transparent
// (every fact comes back through WalkResult); these two module globals exist
// only to preserve the legacy `getTypeName` re-entry guard and the
// `wasDepthExceeded()` read for standalone callers. They are populated FROM the
// WalkResult, never written by the walker. The product path
// (collection-context.ts) reads WalkResult directly and does not touch them.
let typeNameRunning = false;
let depthWasExceeded = false;

/**
 * @deprecated Prefer `createValueWalker(config)(value)` and read the
 * `WalkResult` directly. This shim preserves the legacy
 * `string | null` return plus the module-global re-entry guard.
 */
export function getTypeName(
  value: unknown,
  maxDepth = 5,
  literalOpts?: LiteralOptions,
): string | null {
  if (typeNameRunning) {
    return null;
  }
  typeNameRunning = true;
  depthWasExceeded = false;
  try {
    const result = createValueWalker({ maxDepth, literalOptions: literalOpts })(value);
    if (result.kind === "reentered") return null;
    depthWasExceeded = result.depthExceeded;
    return result.type;
  } finally {
    typeNameRunning = false;
  }
}

/**
 * @deprecated Read `WalkResult.depthExceeded` from
 * `createValueWalker(...)(value)` instead. Valid only immediately after a
 * `getTypeName` call.
 */
export function wasDepthExceeded(): boolean {
  return depthWasExceeded;
}

// --- CollectionContext ---
//
// The stateful collection context + cross-ref signature engine live in
// `collection-context.ts`. Re-exported here so `index.ts` and other
// `./type-collector.js` importers are untouched.
export { createCollectionContext } from "./collection-context.js";
