/**
 * Structural-to-named recognition for common built-ins.
 *
 * When the runtime observes a value whose constructor name is hidden
 * (Proxy, polyfill, or otherwise opaque), `getTypeName` falls back to
 * emitting the value's structural shape. That shape is correct but
 * loses the "this is a Promise / Map / Set / ..." signal — downstream
 * consumers using `await`, `.then`, `Map#get` etc. then see a
 * structural type that doesn't carry the built-in's full interface.
 *
 * This module recognises the structural fingerprints of a small set
 * of always-on built-ins and rewrites the type to the named ref. The
 * verify oracle gates correctness — if the rewrite produces a
 * type-error downstream, apply drops it like any other candidate.
 *
 * Mirrors TS's `inferNamedTypesFromProperties` (in
 * `src/services/codefixes/inferFromUsage.ts:1116`).
 *
 * Out of scope (per the issue):
 *   - User-defined named-type matching — handled by `preferNamedInScope`.
 *   - DOM types (HTMLElement, Event, ...) — vocabulary too large.
 *   - Generic-parameter inference from usage — long-tail; deferred.
 *
 * Generic-args default to `unknown` in this v1 (`Promise<unknown>`,
 * `Map<unknown, unknown>`, etc.). Better recovery from observed call
 * signatures is a follow-up.
 */

import type { TypeNode } from "./type-ir.js";

interface BuiltinShape {
  /** Named-ref output. */
  name: string;
  /** Required property/method names on the structural object form. */
  requiredKeys: readonly string[];
  /** Generic arity — number of type-args to fill with `unknown`. */
  arity: number;
}

/**
 * SHAPES ordering matters: the recognizer checks in declaration order
 * and returns on first match. Specific (more-keys) shapes come BEFORE
 * supersets of their keysets. Map ⊃ Set when only `has`/`delete` are
 * checked, so Map listed first ensures it wins for the Map case.
 */
const SHAPES: readonly BuiltinShape[] = [
  // Promise: identified by `then` + `catch`. `finally` is not required
  // because some polyfills omit it.
  { name: "Promise", requiredKeys: ["then", "catch"], arity: 1 },
  // Map: get/set/has/delete/size. The runtime usually emits these as
  // method shapes (`get(arg): unknown`) which collapse to `unknown`
  // value-type after merging.
  { name: "Map", requiredKeys: ["get", "set", "has", "delete", "size"], arity: 2 },
  // Set: add/has/delete/size. The Map keyset (which includes `set` and
  // `get`) doesn't match this, so order between Map and Set doesn't
  // affect correctness — they're structurally disjoint at these keys.
  { name: "Set", requiredKeys: ["add", "has", "delete", "size"], arity: 1 },
  // Date: a representative subset of Date prototype methods. Browser /
  // Node Date instances expose dozens; we require enough to be confident
  // it's a Date and not a Date-like wrapper.
  { name: "Date", requiredKeys: ["getTime", "getFullYear", "toISOString"], arity: 0 },
  // RegExp: test + exec + source + flags. Sufficient to disambiguate
  // from custom matcher objects.
  { name: "RegExp", requiredKeys: ["test", "exec", "source", "flags"], arity: 0 },
  // Error: name + message + stack. Risk: structural Error-shape might
  // be a user's subclass that hides its name. The wire-in callsite
  // gates this behind a "no constructor name was observed" check so we
  // don't lose user-class distinctions.
  { name: "Error", requiredKeys: ["name", "message", "stack"], arity: 0 },
];

/**
 * If `node` is an `object` TypeNode whose required-key set matches a
 * known built-in's fingerprint, return the named-ref form
 * (`Promise<unknown>`, `Map<unknown, unknown>`, ...). Otherwise null.
 *
 * Doesn't recurse — wire-in callers run this as a post-pass on the
 * top-level merged shape. Recursion into nested object values is a
 * follow-up if needed (rare in practice).
 */
export function recognizeBuiltinShape(node: TypeNode): TypeNode | null {
  if (node.tag !== "object") return null;
  for (const shape of SHAPES) {
    if (matchesShape(node, shape)) {
      const args: TypeNode[] = Array.from({ length: shape.arity }, () => ({
        tag: "prim" as const,
        name: "unknown" as const,
      }));
      return { tag: "ref", name: shape.name, args };
    }
  }
  return null;
}

function matchesShape(node: Extract<TypeNode, { tag: "object" }>, shape: BuiltinShape): boolean {
  // All required keys present in `required` (not just `optional`).
  // An object that has `then` as optional probably isn't a Promise —
  // a real Promise's `then` is always present.
  for (const k of shape.requiredKeys) {
    if (!node.required.has(k)) return false;
  }
  return true;
}
