import { describe, expect, it } from "vitest";

import { _prototypeMergeViaChecker } from "./merge-via-checker.js";
import "./test-utils/matchers.js";

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
 *      here state the flat union the checker returns, documenting
 *      that `getUnionType` is conservative.
 *
 * Together they make the "keep type-ir.ts" decision concrete.
 */

function merge(types: string[]): string | null {
  const result = mergeTypesViaChecker(types);
  return result == null ? null : result.join(" | ");
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
    // The IR lub gives `{ src: string | undefined }`; the checker keeps both.
    const result = merge(["{ src: string }", "{ src: undefined }"]);
    expect(result).toBeTheType("{ src: string } | { src: undefined }");
  });

  it("T[] and Array<T> normalise to a single shape (no cross-syntax dup)", () => {
    // The checker treats `string[]` and `Array<string>` as the same
    // ts.Type — no string-level normalisation needed.
    const result = merge(["string[]", "Array<string>"]);
    expect(result).toBeTheType("string[]");
  });

  it("array-union members are NOT subsumed (negative result — see file docstring)", () => {
    // string[] ⊆ Array<boolean | string> structurally, but the
    // checker's `|` builder does NOT subsume them — both members
    // survive in the output. This is the core motivation for keeping
    // type-ir.ts's `lub` + `isSubtype` (see decision).
    const result = merge(["string[]", "Array<boolean | string>"]);
    expect(result).toBeTheType("string[] | (string | boolean)[]");
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

  it("Promise<T> with different args stays a union of the two (the IR lubs the args)", () => {
    const result = merge(["Promise<string>", "Promise<number>"]);
    expect(result).toBeTheType("Promise<string> | Promise<number>");
  });

  it("shared-key objects stay a union (the IR makes the one-sided key optional)", () => {
    const result = merge(["{ a: number, b: string }", "{ a: number }"]);
    expect(result).toBeTheType("{ a: number; b: string } | { a: number }");
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

  it("keeps the information of the IR on `{ src: string }` vs `{ src: undefined }`", () => {
    const result = merge(["{ src: string }", "{ src: undefined }"]);
    expect(result).toBeTheType("{ src: string } | { src: undefined }");
  });

  it("keeps the subsumed `string[]` the IR drops from `Array<boolean | string>`", () => {
    const result = merge(["string[]", "Array<boolean | string>"]);
    expect(result).toBeTheType("string[] | (boolean | string)[]");
  });
});
