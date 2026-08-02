// The stateful collection context + two-pass cross-ref signature engine. Owns
// the per-run observation log and the deferred signature reconstruction that
// turns scattered param / return / value observations into emitted types.
//
// Layering (DAG, imports strictly downward):
//   collector-contract.ts ← type-signature.ts ← value-walker.ts ← collection-context.ts
import type {
  ApproximationReason,
  CollectedTypeInfo,
  CollectionContext,
  CollectorOptions,
  Diagnostic,
  ExtraOptions,
  SourceLocation,
} from "./collector-contract.js";

import { crossReferenceObservations } from "./cross-reference-observations.js";
import { createValueWalker } from "./value-walker.js";

interface LogKey {
  filename: string;
  pos: number;
  opts: ExtraOptions;
}

export function createCollectionContext(options?: CollectorOptions): CollectionContext {
  const maxDepth = options?.maxDepth ?? 5;
  const literalOptions = options?.literalOptions;
  // Bind one walker for the context's lifetime; record() walks one value per
  // call and reads every fact back through the returned WalkResult — no
  // module-level side-channel.
  const walk = createValueWalker({ maxDepth, literalOptions });
  const logs = new Map<string, Set<string>>();
  const trackedObjects = new WeakMap<object, SourceLocation>();
  const registeredFns = new WeakMap<Function, { retPos: number; filename: string }>();
  // Store function refs recorded as values: logKey → fn ref[]
  const recordedFunctions = new Map<string, Function[]>();
  // Store registered-fn refs that appear as object property values:
  // logKey → Map<memberName, fn>
  const objectMemberFns = new Map<string, Map<string, Function>>();
  // Store parameter names by position key: "filename:pos" → name
  const paramNames = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  // Re-entry guard. When the runtime (@ts-capture/core/preload or
  // @ts-capture/babel-plugin/runtime.cjs) observes a value that's a Proxy
  // whose get-handler is itself instrumented, the get-handler's __tscptr__
  // call would re-enter record(), which walks value[k], which fires the
  // Proxy's get again — mutual recursion until V8 throws RangeError. This
  // flag short-circuits the nested call. (The bound walker also carries its
  // own per-walker re-entry guard as defense-in-depth.)
  // Same fix as the inline collector snippet in @ts-capture/vite/src/index.ts.
  let inRecord = false;

  return {
    diagnostics,

    registerFn(fn, retPos, filename) {
      registeredFns.set(fn, { retPos, filename });
    },

    regFn(fn, retPos, filename) {
      registeredFns.set(fn, { retPos, filename });
      return fn;
    },

    record(name, value, pos, filename, opts) {
      // See `inRecord` declaration for rationale (Proxy-recursion guard).
      // Make the nested call a no-op so the Proxy's get-handler runs
      // cleanly without re-entering the collector.
      if (inRecord) return;
      inRecord = true;
      try {
        const key = JSON.stringify({ filename, pos, opts } satisfies LogKey);
        const objectDeclaration =
          value !== null && (typeof value === "object" || typeof value === "function")
            ? trackedObjects.get(value as object)
            : undefined;

        let typeName: string | null;
        let depthExceeded = false;
        let reason: ApproximationReason | null = null;
        try {
          const result = walk(value);
          // reentered: a nested walk on this context's bound walker (the
          // inRecord guard normally prevents reaching here). Skip, same as a
          // null type — don't store an entry.
          if (result.kind === "reentered") return;
          typeName = result.type;
          depthExceeded = result.depthExceeded;
          reason = result.reason;
        } catch {
          // Defense-in-depth: if the value walk throws (e.g. a getter that
          // raises, or a Proxy variant we haven't anticipated), fall back
          // to "unknown" rather than letting the host program crash.
          typeName = "unknown";
        }
        if (typeName === null) {
          // The walk produced nothing (depth-exceed or recursive walk). Skip
          // the dedup write rather than store a null entry.
          return;
        }

        // Store parameter name for cross-referencing function signatures
        if (!opts.returnType) {
          paramNames.set(`${filename}:${pos}`, name);
        }

        // Store function refs for deferred cross-referencing
        if (typeof value === "function") {
          const existing = recordedFunctions.get(key);
          if (existing) existing.push(value);
          else recordedFunctions.set(key, [value]);
        }

        // Store registered-fn refs found as object property values
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          try {
            const memberFns = new Map<string, Function>();
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
              if (typeof v === "function" && registeredFns.has(v as Function)) {
                memberFns.set(k, v as Function);
              }
            }
            if (memberFns.size > 0) {
              objectMemberFns.set(key, memberFns);
            }
          } catch {
            // Exotic objects (Proxies with throwing traps) are silently
            // ignored — we just won't upgrade any member function types.
          }
        }

        if (depthExceeded) {
          diagnostics.push({
            type: "depth-exceeded",
            message: `Type depth exceeded for parameter "${name}"`,
            filename,
            position: pos,
          });
        }

        // Persist the approximation reason (from WalkResult) alongside the
        // type-name. Apply uses this to emit `/* @ts-capture:<reason> */`
        // markers when `infer.emitDiagnosticComments` is enabled. Only emit
        // the 3rd slot when there's a reason — JSON.stringify turns undefined
        // into null in arrays, which would break the `reason === undefined`
        // checks downstream.
        let set = logs.get(key);
        if (!set) {
          set = new Set();
          logs.set(key, set);
        }
        const entry = reason
          ? [typeName, objectDeclaration, reason]
          : [typeName, objectDeclaration];
        set.add(JSON.stringify(entry));
      } finally {
        inRecord = false;
      }
    },

    track<T>(value: T, filename: string, offset: number): T {
      if (value !== null && (typeof value === "object" || typeof value === "function")) {
        trackedObjects.set(value as object, [filename, offset]);
      }
      return value;
    },

    getCollectedTypes(): CollectedTypeInfo {
      // Resolve live function identity to stable `${filename}:${retPos}` keys
      // at this recording boundary (the only place the WeakMap is consulted),
      // so the cross-reference engine runs on plain, serializable data.
      const recordedFnKeys = new Map<string, string[]>();
      for (const [key, fns] of recordedFunctions) {
        const keys: string[] = [];
        for (const fn of fns) {
          const info = registeredFns.get(fn);
          if (info) keys.push(`${info.filename}:${info.retPos}`);
        }
        if (keys.length > 0) recordedFnKeys.set(key, keys);
      }
      const objectMemberFnKeys = new Map<string, Array<{ member: string; fnKey: string }>>();
      for (const [key, memberFns] of objectMemberFns) {
        const members: Array<{ member: string; fnKey: string }> = [];
        for (const [member, fn] of memberFns) {
          const info = registeredFns.get(fn);
          if (info) members.push({ member, fnKey: `${info.filename}:${info.retPos}` });
        }
        if (members.length > 0) objectMemberFnKeys.set(key, members);
      }
      return crossReferenceObservations({ logs, paramNames, recordedFnKeys, objectMemberFnKeys });
    },
  };
}
