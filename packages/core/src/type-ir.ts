/**
 * Structured intermediate representation for TypeScript type strings,
 * with parser + serializer + lub + isSubtype. Replaces
 * the string-string merging that grew up inside `apply-types.ts`
 * (`mergeObjectTypes`, `mergeKeyValues`) with a single principled
 * pipeline: parse all observations → lub them in IR → serialize once.
 *
 * --- Terminology ---
 *
 * **LUB** (Least Upper Bound) — the most-specific type that
 * subsumes (is a supertype of) every input. Concretely: "the
 * smallest type that accepts every value the observations were."
 * Also called *join* in lattice theory and *anti-unification* in
 * the Plotkin (1970) / Reynolds (1970) sense; TypeScript docs
 * sometimes use "common supertype". Examples:
 *
 *   lub("foo", "bar")          → string
 *   lub(number, string)        → number | string
 *   lub({a: 1}, {a: 1, b: 2})  → {a: number, b?: number}
 *   lub(string, unknown)       → unknown
 *
 * **isSubtype(a, b)** — true when every value of `a` is also a
 * value of `b`. The conservative companion to `lub`: when in
 * doubt return false (false negatives only suppress
 * optimisations, never break correctness).
 *
 * **Anti-unification vs unification** — unification computes the
 * GREATEST lower bound (the intersection of two terms; useful
 * for type inference forward, "what must X be?"). Anti-unification
 * is the dual — the LEAST upper bound, useful when you've
 * observed N specific values and want one type that covers them
 * all without rejecting any.
 *
 * --- Why an IR at all ---
 *
 * Without the IR, each new kind of structural overlap (nullable
 * fields, T[] vs Array<T>, subsumed union members, disjoint
 * discriminated unions) is an ad-hoc string check. With a
 * sum-type IR every case is `(a, b) => TypeNode` and
 * pattern-matches naturally on the two tags.
 *
 * Lean scope: the IR covers what apply's observations actually
 * produce — primitives, literals, arrays/tuples, object literals,
 * named generic refs, function types, unions. Cases the parser can't
 * recognise return a `raw` node that round-trips verbatim and falls
 * back to flat-union semantics in lub. This keeps the parser honest
 * about its limits and lets new shapes land without crashing.
 *
 * --- Why not ts.TypeChecker? ---
 *
 * `ts.TypeChecker.getUnionType` + `typeToString` handles parsing,
 * type-identity dedup, and lib-type resolution, but NOT the
 * anti-unification work that earns this IR its keep:
 *
 *   - Shared-key optional-merge (`{ a, b } ∪ { a } → { a, b? }`):
 *     checker keeps the flat union.
 *   - Nullable-field merge (`{ src: string } ∪ { src: undefined } →
 *     { src: string | undefined }`): checker keeps the flat union.
 *   - Subsumption-aware union dedup (`string[] ∪ unknown[] →
 *     unknown[]`): checker keeps both.
 *
 * The TypeChecker is a type-checking engine, not an
 * anti-unification engine — `getUnionType` is conservative on
 * purpose. The anti-unification rules have to live somewhere
 * regardless of how observations are represented; the choice
 * between "over type strings" and "over `ts.Type` objects" is
 * about substrate, not about reducing surface area.
 */

export type TypeNode =
  /**
   * Atomic primitives plus the "weird" pre-defined names that appear
   * in observations (`undefined`, `null`, `unknown`, `never`, `void`).
   * Kept as one shape rather than two so lub doesn't fork on a
   * boolean tag.
   */
  | { tag: "prim"; name: PrimName }
  /**
   * `"foo"`, `42`, `true`. We carry the exact text — `JSON.stringify`
   * has done its work upstream, so round-tripping is just substring
   * compare. Literal vs base type subsumption (`"foo"` ⊆ `string`)
   * is handled in {@link isSubtype}.
   */
  | { tag: "lit"; kind: "string" | "number" | "boolean"; text: string }
  /** `T[]` and `Array<T>` normalise to the same node. */
  | { tag: "array"; element: TypeNode }
  /** `[T1, T2]`. Length-bound, position-indexed. */
  | { tag: "tuple"; elements: TypeNode[] }
  /**
   * Object literal. Required and optional are kept separate so lub's
   * "key in one but not the other" case is structural, not a flag.
   * Insertion order doesn't matter for semantics; we sort on
   * serialise for stable output.
   */
  | { tag: "object"; required: Map<string, TypeNode>; optional: Map<string, TypeNode> }
  /**
   * Named reference: `Promise<T>`, `Map<K, V>`, `MyInterface`. No
   * args = bare reference. The reference name is opaque to lub —
   * `lub(MyInterface, OtherInterface)` returns their flat union
   * unless both are the same name with lub-able arg lists.
   */
  | { tag: "ref"; name: string; args: TypeNode[] }
  /**
   * `(arg: T) => U`. Param names are preserved for serialisation
   * fidelity but irrelevant to lub (we lub by position).
   */
  | { tag: "fn"; params: FnParam[]; ret: TypeNode }
  /**
   * `T1 | T2 | …` — flattened. The parser never produces nested
   * unions; lub explicitly flattens too.
   */
  | { tag: "union"; members: TypeNode[] }
  /**
   * Fallback for anything the parser doesn't recognise. Carries the
   * original text so serialise(parse(s)) === s for unrecognised
   * shapes. lub on `raw` falls back to flat union.
   */
  | { tag: "raw"; text: string };

export type PrimName =
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "null"
  | "undefined"
  | "void"
  | "unknown"
  | "never"
  | "any";

export interface FnParam {
  name: string;
  type: TypeNode;
  optional: boolean;
}

// --- Sub-modules — re-exported so importers use one path ---

export { parseType } from "./type-ir-parser.js";
export { serializeType, serializeTypeAsUnionMember, widenLiterals } from "./type-ir-serializer.js";
export { isSubtype, lub, lubAll } from "./type-ir-lub.js";
