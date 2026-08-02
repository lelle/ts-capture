import type { TypeNode } from "./type-ir.js";

// Subsumption + least-upper-bound (anti-unification) for the type IR. isSubtype / lub /
// lubAll over TypeNode.

/**
 * Whitespace-canonicalisation for raw-node text comparison. Two raw
 * nodes carrying the same TS type with different interior whitespace
 * (`{foo(x): T}` vs `{ foo(x): T }`) should compare as equal for
 * subsumption-dedup. Collapses runs of whitespace into one space and
 * trims edges. Does not normalise operand order (e.g. `A & B` vs
 * `B & A`) — that would require parsing.
 */
function normalizeRawText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Conservative subtype check on TypeNode. Returns true when every
 * value satisfying `a` also satisfies `b`. Used by lub to dedup union
 * members (drop `a` from `a | b` when `a ⊆ b`) and to recognise that
 * a more-specific shape is already covered by a broader one.
 *
 * Intentionally a lower-bound on real TS subtyping: when we don't
 * know, return false. False negatives only suppress optimisations,
 * never correctness — the worst case is a slightly less-clean union.
 */
export function isSubtype(a: TypeNode, b: TypeNode): boolean {
  // Identity / trivial cases first.
  if (a === b) return true;
  if (b.tag === "prim" && b.name === "unknown") return true;
  if (b.tag === "prim" && b.name === "any") return true;
  if (a.tag === "prim" && a.name === "never") return true;

  // Literal ⊆ matching base prim.
  if (a.tag === "lit" && b.tag === "prim") {
    if (a.kind === "string" && b.name === "string") return true;
    if (a.kind === "number" && b.name === "number") return true;
    if (a.kind === "boolean" && b.name === "boolean") return true;
  }

  // Same-tag recursion.
  if (a.tag === "prim" && b.tag === "prim") return a.name === b.name;
  if (a.tag === "lit" && b.tag === "lit") {
    return a.kind === b.kind && a.text === b.text;
  }
  if (a.tag === "array" && b.tag === "array") {
    return isSubtype(a.element, b.element);
  }
  if (a.tag === "tuple" && b.tag === "tuple") {
    if (a.elements.length !== b.elements.length) return false;
    return a.elements.every((el, i) => isSubtype(el, b.elements[i]));
  }
  if (a.tag === "object" && b.tag === "object") {
    // a ⊆ b iff every key in b is present in a with subtype value,
    // taking required/optional into account.
    for (const [k, vB] of b.required) {
      const vA = a.required.get(k);
      if (!vA) return false;
      if (!isSubtype(vA, vB)) return false;
    }
    for (const [k, vB] of b.optional) {
      const vA = a.required.get(k) ?? a.optional.get(k);
      if (!vA) continue; // optional in b, absent in a — fine
      if (!isSubtype(vA, vB)) return false;
    }
    return true;
  }
  if (a.tag === "ref" && b.tag === "ref") {
    if (a.name !== b.name) return false;
    if (a.args.length !== b.args.length) return false;
    return a.args.every((ar, i) => isSubtype(ar, b.args[i]));
  }
  if (a.tag === "fn" && b.tag === "fn") {
    // Function-type subtyping (per TS): contravariant params, covariant
    // return.
    //
    // Arity: a fn `a` with FEWER params is a subtype of one with MORE
    // (`b`) — callers of b pass enough args, a ignores the extras.
    // Common dual: `(item) => T` ⊆ `(item, index) => T` (`Array#map`
    // callback shapes). The reverse direction is NOT a subtype: a's
    // caller would supply fewer args than b expects.
    if (a.params.length > b.params.length) return false;
    for (let i = 0; i < a.params.length; i++) {
      // Required-vs-optional asymmetry: if a's param is required but
      // b's is optional, b's caller can skip the arg and a receives
      // undefined — which a's required-param type doesn't accept.
      // The other three optional-flag combinations are fine.
      if (!a.params[i].optional && b.params[i].optional) return false;
      // Contravariant: b's param type must be ⊆ a's param type (callers
      // pass values of b's type; a must accept what b would accept).
      if (!isSubtype(b.params[i].type, a.params[i].type)) return false;
    }
    return isSubtype(a.ret, b.ret);
  }
  if (a.tag === "raw" && b.tag === "raw") {
    // Method-shape syntax
    // (`{ foo(arg): ret }`), intersection types (`A & B`), and any
    // other shape our parser bails on land as `raw` nodes carrying
    // the verbatim text. Without this case, two `raw` nodes with
    // identical text returned false for isSubtype.
    //
    // Whitespace normalisation: two semantically-
    // equal raw nodes that differ only in interior whitespace
    // (`{foo(x): T}` vs `{ foo(x): T }`) should collapse in
    // dedupUnionMembers. We compare normalised forms here without
    // mutating the stored `.text` so round-trip remains verbatim.
    return normalizeRawText(a.text) === normalizeRawText(b.text);
  }

  // Union on either side.
  if (a.tag === "union") {
    return a.members.every((m) => isSubtype(m, b));
  }
  if (b.tag === "union") {
    return b.members.some((m) => isSubtype(a, m));
  }

  return false;
}

/**
 * Least upper bound (anti-unifier) of two TypeNodes — the most-
 * specific type that subsumes both. The result is always a well-
 * formed TypeNode; degenerate cases fall back to a flat union
 * (`{ tag: 'union', members: [a, b] }`).
 *
 * Cases handled structurally (no string fallback):
 *   - identical types: unchanged
 *   - one ⊆ the other: return the broader
 *   - both arrays: lub element-wise
 *   - both tuples of same arity: lub element-wise
 *   - both objects: lub on shared keys; keys in only one become
 *     optional. Disjoint keysets (no shared keys at all) fall to
 *     flat union, matching the existing apply heuristic.
 *   - both same-name refs with same arity: lub args
 *   - one union, one anything: flatten and re-lub each pair
 *
 * Disjoint shapes (different tags, no subtype relation): flat
 * union. The verify oracle gates the rest — when the union is
 * a type-error in context, apply rejects the annotation entirely.
 */
export function lub(a: TypeNode, b: TypeNode): TypeNode {
  // Object-object: always go through lubObject. The shortcut
  // `isSubtype(a, b) → return b` would emit the wider object (e.g.
  // `{ a: number }` rather than `{ a: number, b?: string }`), but
  // the anti-unifier principle is "least upper bound" — keep the
  // optional-field info wherever possible.
  if (a.tag === "object" && b.tag === "object") {
    const result = lubObject(a, b);
    if (result !== null) return result;
    return flatUnion(a, b);
  }

  if (isSubtype(a, b)) return b;
  if (isSubtype(b, a)) return a;

  if (a.tag === "array" && b.tag === "array") {
    return { tag: "array", element: lub(a.element, b.element) };
  }
  if (a.tag === "tuple" && b.tag === "tuple" && a.elements.length === b.elements.length) {
    return {
      tag: "tuple",
      elements: a.elements.map((el, i) => lub(el, b.elements[i])),
    };
  }
  if (a.tag === "ref" && b.tag === "ref" && a.name === b.name && a.args.length === b.args.length) {
    return {
      tag: "ref",
      name: a.name,
      args: a.args.map((ar, i) => lub(ar, b.args[i])),
    };
  }
  // Function-type lub: deliberately falls through to flat union.
  //
  // For LUB(F1, F2) to be a supertype of both, params (contravariant)
  // need GLB/intersection and return (covariant) needs LUB. Without an
  // intersection IR node we can't represent the GLB of two param types,
  // and an earlier attempt that used `lub` on params produced the
  // OPPOSITE direction (a subtype of both inputs, not a supertype). Flat
  // union is the honest answer until we either:
  //   - add an `intersection` IR node, or
  //   - extend isSubtype's fn-case to handle arity/optional/rest properly
  // so the early `isSubtype(a, b) → return b` shortcut
  //     catches more identity-like pairs.
  if (a.tag === "union" || b.tag === "union") {
    return unionLub(a, b);
  }

  return flatUnion(a, b);
}

/**
 * Object lub: keys in both are required + value-lub'd; keys in only
 * one become optional with the original value. Two empty objects
 * lub to `{}`. Returns null only when the inputs share zero keys
 * AND both are non-empty — the caller (lub) then falls back to a
 * flat union.
 */
function lubObject(
  a: Extract<TypeNode, { tag: "object" }>,
  b: Extract<TypeNode, { tag: "object" }>,
): TypeNode | null {
  const required = new Map<string, TypeNode>();
  const optional = new Map<string, TypeNode>();
  const aAll = new Map<string, { type: TypeNode; required: boolean }>();
  for (const [k, v] of a.required) aAll.set(k, { type: v, required: true });
  for (const [k, v] of a.optional) aAll.set(k, { type: v, required: false });
  const bAll = new Map<string, { type: TypeNode; required: boolean }>();
  for (const [k, v] of b.required) bAll.set(k, { type: v, required: true });
  for (const [k, v] of b.optional) bAll.set(k, { type: v, required: false });

  const aKeys = new Set(aAll.keys());
  const bKeys = new Set(bAll.keys());
  const aSize = aAll.size;
  const bSize = bAll.size;

  // Disjoint-keysets bail: matches the existing apply heuristic in
  // `mergeObjectTypes` so we don't change behaviour for already-
  // working cases. `{}` is always a valid lub against any object.
  if (aSize > 0 && bSize > 0) {
    const overlap = [...aKeys].some((k) => bKeys.has(k));
    if (!overlap) return null;
  }

  const allKeys = new Set([...aKeys, ...bKeys]);
  for (const k of allKeys) {
    const fromA = aAll.get(k);
    const fromB = bAll.get(k);
    if (fromA && fromB) {
      const merged = lub(fromA.type, fromB.type);
      // Required iff required on BOTH sides.
      if (fromA.required && fromB.required) required.set(k, merged);
      else optional.set(k, merged);
    } else if (fromA) {
      optional.set(k, fromA.type);
    } else if (fromB) {
      optional.set(k, fromB.type);
    }
  }
  return { tag: "object", required, optional };
}

/**
 * Union-aware lub: flatten any union operand, bucket by tag, fold-lub
 * within each bucket so same-shape members (multiple objects, multiple
 * `Array<…>`, multiple `Promise<…>`, etc.) genuinely merge instead of
 * being kept side-by-side. Then subsumption-aware dedup over the
 * combined result.
 *
 * Without the per-tag fold, the union `{ name: string } | { name: string, age: number }`
 * would dedup via `isSubtype` (the broader `{ name }` wins, `age` is
 * lost). Folding first turns the same input into
 * `{ age?: number, name: string }` — keeps the `age` information as
 * optional. This is the lub that anti-unification's "least upper
 * bound" actually wants.
 */
function unionLub(a: TypeNode, b: TypeNode): TypeNode {
  const all: TypeNode[] = [];
  const aMembers = a.tag === "union" ? a.members : [a];
  const bMembers = b.tag === "union" ? b.members : [b];
  for (const m of [...aMembers, ...bMembers]) {
    if (m.tag === "union") all.push(...m.members);
    else all.push(m);
  }

  const objects: TypeNode[] = [];
  const arrays: TypeNode[] = [];
  const tuples: TypeNode[] = [];
  const fns: TypeNode[] = [];
  const refsByName = new Map<string, TypeNode[]>();
  const others: TypeNode[] = [];
  for (const m of all) {
    if (m.tag === "object") objects.push(m);
    else if (m.tag === "array") arrays.push(m);
    else if (m.tag === "tuple") tuples.push(m);
    else if (m.tag === "fn") fns.push(m);
    else if (m.tag === "ref") {
      const arr = refsByName.get(m.name) ?? [];
      arr.push(m);
      refsByName.set(m.name, arr);
    } else {
      others.push(m);
    }
  }

  const collapsed: TypeNode[] = [
    ...others,
    ...foldLubBucket(objects),
    ...foldLubBucket(arrays),
    ...foldLubBucket(tuples),
    ...foldLubBucket(fns),
  ];
  for (const refs of refsByName.values()) {
    collapsed.push(...foldLubBucket(refs));
  }
  return dedupUnionMembers(collapsed);
}

/**
 * Group a bucket of same-tag (or same-name-ref) members by pairwise lub
 * compatibility. Compatible members (lub doesn't bail to a flat union)
 * are absorbed into a single accumulator; disjoint members start a new
 * group.
 *
 * The earlier implementation was a single left-fold with flush-on-
 * disjoint: when an intermediate pair was disjoint, it flushed `acc`
 * and never retried the flushed member against later compatible ones.
 * That made `lubAll([A,B,C])` ≠ `lubAll([A,C,B])` when A↔C compatible
 * but A↔B disjoint — the [A,B,C] order flushed A before reaching C,
 * losing the A↔C merge. see the issue
 *
 * The current implementation is absorb-then-restart: for each acc,
 * scan remaining members repeatedly, absorbing every compatible one;
 * after each absorption restart the scan because the new acc may be
 * compatible with members that were disjoint from the old acc. O(N²)
 * per group in the worst case, but typical bucket sizes are small
 * (< 10) so this is well within budget.
 */
function foldLubBucket(members: TypeNode[]): TypeNode[] {
  if (members.length === 0) return [];
  if (members.length === 1) return [members[0]];
  const remaining = [...members];
  const out: TypeNode[] = [];
  while (remaining.length > 0) {
    let acc = remaining.shift()!;
    let absorbed = true;
    while (absorbed) {
      absorbed = false;
      for (let i = 0; i < remaining.length; i++) {
        const merged = lub(acc, remaining[i]);
        if (merged.tag !== "union") {
          acc = merged;
          remaining.splice(i, 1);
          absorbed = true;
          break;
        }
      }
    }
    out.push(acc);
  }
  return out;
}

function flatUnion(a: TypeNode, b: TypeNode): TypeNode {
  return dedupUnionMembers([a, b]);
}

/**
 * Drop union members subsumed by another member. Preserves order of
 * first appearance for diff stability before the serializer sorts.
 */
function dedupUnionMembers(members: TypeNode[]): TypeNode {
  const flat: TypeNode[] = [];
  for (const m of members) {
    if (m.tag === "union") flat.push(...m.members);
    else flat.push(m);
  }
  const kept: TypeNode[] = [];
  for (const m of flat) {
    if (kept.some((k) => isSubtype(m, k))) continue;
    // m is broader than some kept entries — drop those.
    for (let i = kept.length - 1; i >= 0; i--) {
      if (isSubtype(kept[i], m)) kept.splice(i, 1);
    }
    kept.push(m);
  }
  if (kept.length === 1) return kept[0];
  return { tag: "union", members: kept };
}

/**
 * lub over an arbitrary number of observations. Fold-left so the
 * result depends only on member set (lub is associative + commutative
 * for the shapes we model).
 */
export function lubAll(nodes: TypeNode[]): TypeNode {
  if (nodes.length === 0) return { tag: "prim", name: "unknown" };
  let acc = nodes[0];
  for (let i = 1; i < nodes.length; i++) acc = lub(acc, nodes[i]);
  return acc;
}
