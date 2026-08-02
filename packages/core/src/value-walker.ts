// The recursive runtime-value walker. Takes a
// live JS value and produces its structural TypeScript type string. Pure
// reflection — `typeof`, `constructor.name`, `Symbol.iterator`,
// `fn.toString()` — with no `ts.Program`, no I/O, and no module-level mutable
// state: every fact the caller needs (the type, the approximation reason, the
// depth-exceeded flag, the re-entry verdict) comes back through `WalkResult`.
//
// Layering (DAG, imports strictly downward):
//   collector-contract.ts ← type-signature.ts ← value-walker.ts
import type { ApproximationReason, LiteralOptions } from "./collector-contract.js";

import {
  coarseTypeFallback,
  encodeClassWithChain,
  formatTypeSet,
  getInheritanceChain,
  resolveFunctionType,
  tryConvertToMethodShape,
  TS_CAPTURE_INTERNAL_KEY,
} from "./type-signature.js";

/** Per-context-fixed config — set once, closed over by the walker. */
export interface WalkerConfig {
  /** Maximum recursion depth before bailing to `null`. Default 5. */
  maxDepth?: number;
  literalOptions?: LiteralOptions;
}

/**
 * Outcome of walking one runtime value. Replaces the legacy
 * `string | null` return plus the two read-after-call module globals
 * (`depthWasExceeded`, `lastApproximationReason`).
 */
export type WalkResult =
  | {
      kind: "ok";
      type: string | null;
      reason: ApproximationReason | null;
      depthExceeded: boolean;
    }
  | { kind: "reentered" }; // the re-entry guard tripped → caller skips

export type Walk = (value: unknown) => WalkResult;

/**
 * Mutable per-walk scratch state, threaded through the `resolveType`
 * subtree in place of the old module-level globals. One allocated per
 * `walk()` call; never shared across walks.
 */
interface WalkState {
  maxDepth: number;
  visited: Set<object>;
  literalOpts: LiteralOptions | undefined;
  /** Set true when any branch bailed at the depth limit. */
  depthExceeded: boolean;
}

/**
 * Detect React-element values via the `$$typeof` symbol.
 *
 * React tags every element with a well-known symbol so it can be
 * distinguished from plain objects without a constructor check.
 * Pre-React-19: `Symbol.for("react.element")`. React 19+ transitional
 * branch: `Symbol.for("react.transitional.element")`. Other entries
 * in the React `$$typeof` vocabulary (`react.portal`, `react.fragment`,
 * `react.context`, `react.memo`, `react.forward_ref`, etc.) are also
 * representable as `JSX.Element` for ts-capture's purposes — the
 * downstream emitter would otherwise walk the internal FiberNode /
 * `_owner` / `_store` shape, leaking React's private types into apply
 * (which then rejects the whole annotation in `allTypeRefsInScope`).
 *
 * Detection is brand-based, not library-based: React is the one UI library
 * core hardcodes (stable `$$typeof` brand + import-free UMD global). Other
 * JSX frameworks (Solid/Vue/Qwik/native Preact) carry no `react.*` brand,
 * so they never match here and are never mislabeled — they fall through to
 * the structural walk and get dropped by scope-reachability. That scope
 * boundary and the deferred plugin-registry path are documented in
 * docs/explanation/jsx-element-typing.md.
 *
 * Defensive: protected by try/catch since the value may be a Proxy
 * with a throwing get-handler. `$$typeof` must be a Symbol with a
 * description starting with "react.".
 */
function isReactElement(value: object): boolean {
  try {
    const marker = (value as Record<string, unknown>)["$$typeof"];
    if (typeof marker !== "symbol") return false;
    const desc = marker.description;
    return typeof desc === "string" && desc.startsWith("react.");
  } catch {
    return false;
  }
}

function resolveType(value: unknown, depth: number, state: WalkState): string | null {
  if (depth >= state.maxDepth) {
    state.depthExceeded = true;
    return null;
  }

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  // ts-capture.peek protocol: a value can opt into safe inspection by
  // attaching a function under Symbol.for("ts-capture.peek"). When set,
  // we walk the function's return value instead of the value itself.
  // This is how framework adapters (Vue/MobX/Solid/Effect.ts/etc.)
  // expose their unwrapped state without us having to know about each
  // library's internal sigils. Library-specific knowledge belongs
  // A configurable TypeResolver registry remains outside core's scope.
  if (typeof value === "object" || typeof value === "function") {
    try {
      const peek = (value as Record<symbol, unknown>)[Symbol.for("ts-capture.peek")];
      if (typeof peek === "function") value = peek.call(value);
    } catch {
      // peek threw — fall through to walking the original value
    }
  }

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint" || t === "symbol") {
    // Optional literal-type emission (gated by literalOpts).
    const literalOpts = state.literalOpts;
    if (t === "string" && literalOpts?.literalString) {
      const max = literalOpts.literalStringMaxLength ?? 16;
      if (typeof value === "string" && value.length <= max) {
        return JSON.stringify(value);
      }
    }
    if (t === "number" && literalOpts?.literalNumber) {
      // Skip non-finite numbers — `NaN`/`Infinity` aren't valid TS literal types
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    if (t === "boolean" && literalOpts?.literalBoolean) {
      return String(value);
    }
    return t;
  }

  // Circular reference detection for objects and arrays
  if (typeof value === "object" || typeof value === "function") {
    if (state.visited.has(value as object)) return null;
    state.visited.add(value as object);
  }

  if (Array.isArray(value)) {
    return resolveArrayType(value, depth, state);
  }

  if (typeof value === "function") {
    return resolveFunctionType(value);
  }

  if (typeof value === "object") {
    // A React element looks like a plain object with a private
    // FiberNode-typed `_owner` and a symbolic `$$typeof` marker.
    // Walking it structurally leaks `FiberNode` etc. into apply's emit,
    // which then gets rejected by `allTypeRefsInScope`. Emit
    // `React.ReactElement` — the public type, accessible via the
    // UMD `export as namespace React` in @types/react, so it works
    // without an explicit React import. Covers React 18 and 19+
    // (global `JSX.Element` was removed in @types/react@19, but
    // `React.ReactElement` is stable across versions).
    if (isReactElement(value as object)) return "React.ReactElement";

    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;

    // Iteration-protocol detection covers three failure modes for
    // structural walking:
    //   (1) Built-in iterators (`arr[Symbol.iterator]()`, `map.entries()`,
    //       `set.values()`) have ctor names with SPACES — "Array Iterator",
    //       "Map Iterator", "Set Iterator". Emitting those verbatim is
    //       invalid TS.
    //   (2) Generator / AsyncGenerator instances have `constructor.name === ""`
    //       in V8 (anonymous Generator prototype), so they fall through to
    //       the structural walk and emit `{}` — even less useful.
    //   (3) POJO iterables (`{ next, [Symbol.iterator] }`) have ctorName
    //       "Object" and would emit the next/done shape, losing iteration intent.
    // Skip when the ctor name is a TS-valid identifier handled by another
    // branch already: Map/Set/Array are caught earlier by their dedicated
    // checks; user-defined iterable classes (e.g. `class MyCollection`)
    // emit better as their own name.
    const asyncIter = (value as Record<symbol, unknown>)[Symbol.asyncIterator];
    const syncIter = (value as Record<symbol, unknown>)[Symbol.iterator];
    if (typeof asyncIter === "function" || typeof syncIter === "function") {
      // The gate covers four failure modes for ctor-name fallback:
      //   - "" (anonymous Generator/AsyncGenerator prototype in V8)
      //   - "Object" (POJO iterables)
      //   - "Array Iterator" / "Map Iterator" / "Set Iterator" (older V8)
      //   - "Iterator" / "AsyncIterator" (modern Node — valid TS but bare-
      //     generic without ctor-arity expansion, fragile across runtimes)
      // User-defined iterable classes (`class MyCollection`) — emit better
      // as their own constructor name, so don't override those.
      if (
        !ctorName ||
        ctorName === "Object" ||
        ctorName.includes(" ") ||
        ctorName === "Iterator" ||
        ctorName === "AsyncIterator"
      ) {
        if (typeof asyncIter === "function") return "AsyncIterableIterator<unknown>";
        return "IterableIterator<unknown>";
      }
    }

    if (ctorName && ctorName !== "Object") {
      if (value instanceof Map) return resolveMapType(value, depth, state);
      if (value instanceof Set) return resolveSetType(value, depth, state);
      // Bare `Promise` emits TS2314 "Generic type 'Promise<T>' requires
      // 1 type argument(s)". We can't see the resolved value without
      // awaiting, so emit `Promise<unknown>`. Strictly better than
      // bare `Promise`.
      if (value instanceof Promise) return resolvePromiseType();
      // WeakMap and WeakSet can't be iterated at runtime (the whole
      // point of weak refs is they're not enumerable). Emit with
      // default-filled type params so TS2314 doesn't fire. K=object
      // since WeakKey defaults to object in current TS lib.
      if (typeof WeakMap !== "undefined" && value instanceof WeakMap) {
        return "WeakMap<object, unknown>";
      }
      if (typeof WeakSet !== "undefined" && value instanceof WeakSet) {
        return "WeakSet<object>";
      }
      if (state.literalOpts?.captureClassHierarchy) {
        return encodeClassWithChain(ctorName, getInheritanceChain(value as object));
      }
      return ctorName;
    }
    return resolveObjectType(value as Record<string, unknown>, depth, state);
  }

  return t;
}

function resolveArrayType(arr: unknown[], depth: number, state: WalkState): string {
  if (arr.length === 0) return "unknown[]";

  const typeSet = new Set<string>();
  for (const item of arr) {
    const name = resolveType(item, depth + 1, state);
    if (name !== null) typeSet.add(name);
  }

  if (typeSet.size === 0) return "unknown[]";
  if (typeSet.size === 1) return [...typeSet][0] + "[]";

  const sorted = [...typeSet].sort();
  return `Array<${sorted.join(" | ")}>`;
}

/**
 * Promise instances always emit `Promise<unknown>`. Walking the resolved
 * value would require awaiting, which would deform the program (turn a
 * synchronous observation into an async one). The `unknown` is honest:
 * at observation time we don't know what the Promise will resolve to.
 */
function resolvePromiseType(): string {
  return "Promise<unknown>";
}

function resolveMapType(map: Map<unknown, unknown>, depth: number, state: WalkState): string {
  if (map.size === 0) return "Map<unknown, unknown>";

  const keyTypes = new Set<string>();
  const valueTypes = new Set<string>();
  for (const [k, v] of map) {
    const kt = resolveType(k, depth + 1, state);
    if (kt !== null) keyTypes.add(kt);
    const vt = resolveType(v, depth + 1, state);
    if (vt !== null) valueTypes.add(vt);
  }

  const keyStr = formatTypeSet(keyTypes, "unknown");
  const valStr = formatTypeSet(valueTypes, "unknown");
  return `Map<${keyStr}, ${valStr}>`;
}

function resolveSetType(set: Set<unknown>, depth: number, state: WalkState): string {
  if (set.size === 0) return "Set<unknown>";

  const typeSet = new Set<string>();
  for (const item of set) {
    const name = resolveType(item, depth + 1, state);
    if (name !== null) typeSet.add(name);
  }

  return `Set<${formatTypeSet(typeSet, "unknown")}>`;
}

function resolveObjectType(obj: Record<string, unknown>, depth: number, state: WalkState): string {
  const keys = Object.keys(obj)
    .filter((k) => !TS_CAPTURE_INTERNAL_KEY.test(k))
    .sort();
  if (keys.length === 0) return "{}";

  const pairs = keys.map((key) => {
    // Valid TS identifiers can't start with a digit. The previous test
    // /^[a-z0-9_]+$/i incorrectly accepted keys like "3g2" or "5xx" which
    // require quoting in object type literals.
    const isValidIdentifier = /^[a-z_$][\w$]*$/i;
    const escapedKey = isValidIdentifier.test(key) ? key : JSON.stringify(key);
    const valueType = resolveType(obj[key], depth + 1, state) ?? "unknown";

    // When a property's type is a function-arrow shape, emit it as a
    // method-shape (`key(args): ret`) instead of a property
    // (`key: (args) => ret`). TS treats method-shaped members as
    // bivariant in parameter types, while property-shaped function
    // members are contravariant under --strictFunctionTypes. The
    // method form lets narrower callsite callbacks satisfy the prop
    // type without TS2322 — the dominant variance failure on real React
    // codebases with strict callback props.
    const methodForm = tryConvertToMethodShape(valueType, escapedKey);
    if (methodForm !== null) return methodForm;

    return `${escapedKey}: ${valueType}`;
  });

  return `{ ${pairs.join(", ")} }`;
}

/**
 * Bind a walker config once and return a `walk` function that maps one
 * runtime value to a `WalkResult`. The re-entry guard is scoped to this
 * walker (not a module global), so two independently-constructed walkers
 * can no longer false-trip each other's guard.
 *
 * The dominant caller (`createCollectionContext`) builds one walker and
 * walks one value per `record()`. A bare `getTypeName(v)` builds a
 * throwaway walker per call.
 */
export function createValueWalker(config: WalkerConfig = {}): Walk {
  const maxDepth = config.maxDepth ?? 5;
  const literalOpts = config.literalOptions;
  let running = false;

  return function walk(value: unknown): WalkResult {
    if (running) return { kind: "reentered" };
    running = true;
    const state: WalkState = {
      maxDepth,
      visited: new Set<object>(),
      literalOpts,
      depthExceeded: false,
    };
    try {
      const result = resolveType(value, 0, state);
      if (result === null) {
        return { kind: "ok", type: null, reason: null, depthExceeded: state.depthExceeded };
      }
      // Cap the emitted size. Deeply-nested wide objects (Redux stores,
      // React Hook Form's `_props.current.control`, etc.) can produce
      // 500KB+ single-line type strings that break downstream parsers.
      // When over budget, fall back to a coarse type that captures the
      // kind without the shape.
      const maxChars = literalOpts?.maxAnnotationChars ?? 4096;
      if (result.length > maxChars) {
        return {
          kind: "ok",
          type: coarseTypeFallback(value),
          reason: "shape-capped",
          depthExceeded: true,
        };
      }
      return { kind: "ok", type: result, reason: null, depthExceeded: state.depthExceeded };
    } finally {
      running = false;
    }
  };
}
