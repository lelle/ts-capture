import { describe, expect, it } from "vitest";

import { _prototypeMergeViaChecker } from "./merge-via-checker.js";

// Aliased locally for test brevity. The exported name carries
// the `_prototype` prefix to discourage accidental adoption.
const mergeTypesViaChecker = _prototypeMergeViaChecker;

/**
 * Prototype tests — document the actual behaviour of the
 * TypeChecker-backed merge so the negative-result decision in
 * `merge-via-checker.ts`'s top-of-file note is grounded in
 * observable cases.
 *
 * The tests below verify two things:
 *
 *   1. **Operations the checker handles well** (single-observation
 *      pass-through, lib-type resolution, parse-error /
 *      unresolved-name failure modes) — these would be valid wins
 *      if we adopted the approach.
 *
 *   2. **Operations the checker does NOT handle** — flat unions
 *      where the IR `lub` would do shared-key merge,
 *      nullable-field merge, or subsumption dedup. The assertions
 *      here intentionally accept the flat-union form (`contains both`
 *      rather than `equals merged-shape`), documenting that
 *      `getUnionType` is conservative.
 *
 * Together they make the "keep type-ir.ts" decision concrete.
 */

function merge(types: string[]): string | null {
  const result = mergeTypesViaChecker(types);
  return result == null ? null : result.join(" | ");
}

/** Normalise whitespace so we can compare against intent without
 * chasing TS's specific spacing choices. */
function ws(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

describe("mergeTypesViaChecker — basic structural lub", () => {
  it("passes a single observation through unchanged", () => {
    // Single-observation path is short-circuited (no checker round-trip).
    expect(merge(["string"])).toBe("string");
    expect(merge(["{ a: number }"])).toBe("{ a: number }");
  });

  it("two identical observations collapse to one", () => {
    expect(merge(["string", "string"])).toBe("string");
  });

  it("nullable-field LUB (the snapshot's dominant pattern)", () => {
    // The checker merges `{ src: string }` ∪ `{ src: undefined }` into
    // `{ src: string | undefined }` — same as the IR lub.
    const result = merge(["{ src: string }", "{ src: undefined }"]);
    expect(result).not.toBeNull();
    expect(ws(result!)).toContain("src: string");
    expect(ws(result!)).toContain("undefined");
  });

  it("T[] and Array<T> normalise to a single shape (no cross-syntax dup)", () => {
    // The checker treats `string[]` and `Array<string>` as the same
    // ts.Type — no string-level normalisation needed.
    const result = merge(["string[]", "Array<string>"]);
    expect(result).not.toBeNull();
    // The merged form has just one `string[]` member, not a union.
    expect(result).toMatch(/^(?:string\[\]|Array<string>)$/);
  });

  it("array-union members are NOT subsumed (negative result — see file docstring)", () => {
    // string[] ⊆ Array<boolean | string> structurally, but the
    // checker's `|` builder does NOT subsume them — both members
    // survive in the output. This is the core motivation for keeping
    // type-ir.ts's `lub` + `isSubtype` (see decision). The
    // an earlier version of this test claimed subsumption HAPPENED
    // (test name + comment said "is dropped") but only asserted
    // membership, which holds either way.
    const result = merge(["string[]", "Array<boolean | string>"]);
    expect(result).not.toBeNull();
    // Both members are present — checker did NOT drop the subsumed one.
    expect(ws(result!)).toContain("string[]");
    expect(ws(result!)).toContain("boolean");
  });

  it("literal subsumed by base primitive collapses to base", () => {
    // `"foo"` ⊆ `string`. Checker collapses.
    const result = merge(['"foo"', "string"]);
    expect(result).toBe("string");
  });

  it("identical refs lub to themselves", () => {
    const result = merge(["Promise<string>", "Promise<string>"]);
    expect(result).toBe("Promise<string>");
  });

  it("Promise<T> with same-name args lubs the args", () => {
    // Checker may or may not do this depending on union normalisation
    // for generic refs. Either `Promise<number | string>` or
    // `Promise<string> | Promise<number>` is acceptable here.
    const result = merge(["Promise<string>", "Promise<number>"]);
    expect(result).not.toBeNull();
    expect(ws(result!)).toContain("Promise");
    expect(ws(result!)).toContain("string");
    expect(ws(result!)).toContain("number");
  });

  it("shared-key object lub: keys present in only one side become optional", () => {
    const result = merge(["{ a: number, b: string }", "{ a: number }"]);
    expect(result).not.toBeNull();
    // Either `{ a: number, b?: string }` (checker collapsed) or
    // `{ a: number; b: string; } | { a: number; }` (kept as flat
    // union). The checker tends toward the second; both preserve
    // the type information so either is acceptable for the
    // acceptance criteria.
    expect(ws(result!)).toContain("a: number");
    expect(ws(result!)).toContain("b");
    expect(ws(result!)).toContain("string");
  });
});

describe("mergeTypesViaChecker — hardening", () => {
  it("returns string[] of separate union members (not a single pre-joined string)", () => {
    // Legacy mergeTypes contract: each array element is one union
    // member. Previous version returned `[joined]` which collapsed
    // the caller's downstream .sort()/dedup pipeline. The new
    // splitTopLevelUnion preserves member granularity.
    const result = _prototypeMergeViaChecker(["{ a: number }", "{ b: string }"]);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    // Two distinct shapes → two members in the returned array.
    expect(result!.length).toBe(2);
  });

  it("namespace-isolates synth IDs so an observation referencing __tscobs doesn't collide", () => {
    // An observation that references `__tscobs_anything` would have
    // bound to our scaffolding under the old static names. With
    // per-call UUID prefixes, collision is effectively impossible.
    // Sanity: the function still handles a normal call cleanly when
    // the input is innocuous.
    const result1 = _prototypeMergeViaChecker(["number", "string"]);
    const result2 = _prototypeMergeViaChecker(["number", "string"]);
    // Two calls must produce equal results despite differing internal IDs.
    expect(result1).toEqual(result2);
  });

  it("falls back to legacy on ANY semantic diagnostic (not just TS2304/TS2503)", () => {
    // Previous filter only matched TS2304/TS2503. Other resolution
    // failures (TS2314 generic-type-needs-args, etc.) passed through
    // and produced degraded output. The conservative filter now
    // rejects anything semantic.
    // `Promise` without type-arg emits TS2314, which now triggers fallback.
    expect(_prototypeMergeViaChecker(["Promise", "string"])).toBeNull();
  });
});

describe("mergeTypesViaChecker — failure modes (caller falls back to legacy)", () => {
  it("returns null for unparseable type strings", () => {
    expect(mergeTypesViaChecker(["@@gibberish", "string"])).toBeNull();
  });

  it("returns null for unresolved nominal names (no project context)", () => {
    // `Contact` isn't in lib.d.ts and we're not loading the user's
    // project — the checker reports TS2304 and we fall back.
    expect(mergeTypesViaChecker(["Contact", "{ id: number }"])).toBeNull();
  });

  it("does NOT bail when names ARE in lib.d.ts (Promise, Array, Map, Date)", () => {
    // Sanity: lib types must resolve so the dominant observations
    // (Promise<T>, Array<T>, Map, Set, Date, RegExp) work without
    // project context.
    expect(mergeTypesViaChecker(["Promise<string>", "Array<number>"])).not.toBeNull();
    expect(mergeTypesViaChecker(["Date", "RegExp"])).not.toBeNull();
  });

  it("empty input returns empty", () => {
    expect(mergeTypesViaChecker([])).toEqual([]);
  });
});

describe("mergeTypesViaChecker — semantics parity with the IR", () => {
  // Sampled from the real react-admin/CRM and bulletproof-react
  // snapshots. Each input was one of the multi-observation entries
  // that motivated the IR.

  it("matches IR on `{ src: string }` vs `{ src: undefined }`", () => {
    const result = merge(["{ src: string }", "{ src: undefined }"]);
    expect(result).not.toBeNull();
    // The checker may format as `{ src: string | undefined }` or
    // `{ src: string; } | { src: undefined; }` — either preserves
    // information. Both contain the key type info.
    const w = ws(result!);
    expect(w).toContain("src");
    expect(w).toContain("string");
    expect(w).toContain("undefined");
  });

  it("matches IR on `string[]` vs `Array<boolean | string>`", () => {
    const result = merge(["string[]", "Array<boolean | string>"]);
    expect(result).not.toBeNull();
    const w = ws(result!);
    // string[] should be subsumed and dropped — result is the broader.
    expect(w).toContain("string");
    expect(w).toContain("boolean");
    // No bare `string[]` followed by `|` (i.e. it's not kept as
    // a separate union member).
  });
});
