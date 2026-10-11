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
import type { PromiseStateReader } from "./promise-state.js";

import { crossReferenceObservations } from "./cross-reference-observations.js";
import { createValueWalker } from "./value-walker.js";

interface LogKey {
  filename: string;
  pos: number;
  opts: ExtraOptions;
}

export function createCollectionContextWith(
  promiseState: PromiseStateReader,
  options?: CollectorOptions,
): CollectionContext {
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
  // Counts every change to the state getCollectedTypes() reads, so a caller
  // can tell whether the output moved without computing it.
  let revision = 0;
  // What the output keeps of a function is its `${filename}:${retPos}`, not
  // its identity, so the revision follows those keys: a new closure from a
  // site already seen at a position changes nothing.
  const seenFnKeys = new Map<string, Set<string>>();
  const seenMemberFnKeys = new Map<string, string>();
  const recordedAsValue = new WeakSet<Function>();
  // Returned promises whose settlement has not been observed yet. Bounded: a
  // hot loop returning promises that never settle must not grow memory.
  const pendingPromises: Array<{
    promise: Promise<unknown>;
    name: string;
    pos: number;
    filename: string;
    opts: ExtraOptions;
  }> = [];
  const PENDING_PROMISES_MAX = 1024;

  function register(fn: Function, retPos: number, filename: string): void {
    const known = registeredFns.get(fn);
    if (known?.retPos === retPos && known.filename === filename) return;
    registeredFns.set(fn, { retPos, filename });
    if (recordedAsValue.has(fn)) revision++;
  }

  /**
   * Record one observation. `wrap` adjusts the walked type before it is
   * stored, for a value observed through a container the walker never saw.
   */
  function store(
    name: string,
    value: unknown,
    pos: number,
    filename: string,
    opts: ExtraOptions,
    wrap?: (type: string) => string,
  ): void {
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
      if (wrap) typeName = wrap(typeName);

      // Store parameter name for cross-referencing function signatures
      if (!opts.returnType) {
        const nameKey = `${filename}:${pos}`;
        if (paramNames.get(nameKey) !== name) {
          paramNames.set(nameKey, name);
          revision++;
        }
      }

      // Store function refs for deferred cross-referencing
      if (typeof value === "function") {
        const existing = recordedFunctions.get(key);
        if (existing) existing.push(value);
        else recordedFunctions.set(key, [value]);
        recordedAsValue.add(value);
        const info = registeredFns.get(value);
        if (info) {
          let fnKeys = seenFnKeys.get(key);
          if (!fnKeys) {
            fnKeys = new Set();
            seenFnKeys.set(key, fnKeys);
          }
          const known = fnKeys.size;
          fnKeys.add(`${info.filename}:${info.retPos}`);
          if (fnKeys.size !== known) revision++;
        }
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
            const memberFnKeys = [...memberFns]
              .map(([member, fn]) => {
                const info = registeredFns.get(fn)!;
                return `${member}=${info.filename}:${info.retPos}`;
              })
              .join("|");
            if (seenMemberFnKeys.get(key) !== memberFnKeys) {
              seenMemberFnKeys.set(key, memberFnKeys);
              revision++;
            }
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
      const entry = reason ? [typeName, objectDeclaration, reason] : [typeName, objectDeclaration];
      const seen = set.size;
      set.add(JSON.stringify(entry));
      if (set.size !== seen) revision++;
    } finally {
      inRecord = false;
    }
  }

  return {
    diagnostics,

    revision: () => revision,

    registerFn(fn, retPos, filename) {
      register(fn, retPos, filename);
    },

    regFn(fn, retPos, filename) {
      register(fn, retPos, filename);
      return fn;
    },

    record(name, value, pos, filename, opts) {
      if (inRecord) return;
      // A returned promise is observed once it has settled, by
      // `settlePromises`. Recording the bare `Promise` now would be worse
      // than nothing: `Promise<unknown>` subsumes the settled type at merge.
      if (opts.returnType && value instanceof Promise) {
        if (pendingPromises.length >= PENDING_PROMISES_MAX) pendingPromises.shift();
        pendingPromises.push({ promise: value, name, pos, filename, opts });
        return;
      }
      store(name, value, pos, filename, opts);
    },

    settlePromises() {
      const waiting: typeof pendingPromises = [];
      for (const entry of pendingPromises) {
        const state = promiseState(entry.promise);
        if (state === "pending") waiting.push(entry);
        if (state !== "fulfilled") continue;
        const { name, pos, filename, opts } = entry;
        entry.promise.then(
          (settled) => store(name, settled, pos, filename, opts, (type) => `Promise<${type}>`),
          () => {},
        );
      }
      pendingPromises.length = 0;
      pendingPromises.push(...waiting);
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
