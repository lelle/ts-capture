import { describe, expect, it } from "vitest";

import { INFER_DEFAULTS, type InferOptions } from "./configuration.js";
import { collapseLiteral, mergeTypes, parseObjectType, splitTopLevelUnion } from "./type-merge.js";

// Boundary / characterization spec for the type-merge algebra. type-merge.ts
// had no dedicated spec — it was exercised only through the 4,604-line
// apply-types.spec.ts. These tests pin the current observable behavior at the
// function boundary, so a future IR-first rewrite has a direct safety net.

const litOn: InferOptions = {
  ...INFER_DEFAULTS,
  literal: { string: true, stringMaxLength: 16, number: true, boolean: true },
};

describe("mergeTypes", () => {
  it("deduplicates identical observations", () => {
    expect(mergeTypes(["string", "string"], INFER_DEFAULTS)).toEqual(["string"]);
  });

  it("keeps distinct primitives as a union (members preserved, order stable)", () => {
    expect(mergeTypes(["string", "number"], INFER_DEFAULTS)).toEqual(["string", "number"]);
  });

  it("recursively merges overlapping object shapes by default", () => {
    expect(mergeTypes(["{ a: number }", "{ a: string }"], INFER_DEFAULTS)).toEqual([
      "{ a: number | string }",
    ]);
  });

  it("keeps disjoint object shapes as separate union members", () => {
    expect(mergeTypes(["{ a: number }", "{ b: string }"], INFER_DEFAULTS)).toEqual([
      "{ a: number }",
      "{ b: string }",
    ]);
  });

  it("leaves cross-sample arrays separate when crossSampleArrayMerge is off", () => {
    expect(mergeTypes(["number[]", "string[]"], INFER_DEFAULTS)).toEqual(["number[]", "string[]"]);
  });

  it("merges cross-sample arrays into one element union when the flag is on", () => {
    const infer: InferOptions = { ...INFER_DEFAULTS, crossSampleArrayMerge: true };
    expect(mergeTypes(["number[]", "string[]"], infer)).toEqual(["Array<number | string>"]);
  });
});

describe("collapseLiteral", () => {
  it("widens literals to their base type by default", () => {
    expect(collapseLiteral('"yes"', INFER_DEFAULTS)).toBe("string");
    expect(collapseLiteral("42", INFER_DEFAULTS)).toBe("number");
    expect(collapseLiteral("true", INFER_DEFAULTS)).toBe("boolean");
  });

  it("preserves literals when the literal flags are enabled", () => {
    expect(collapseLiteral('"yes"', litOn)).toBe('"yes"');
    expect(collapseLiteral("42", litOn)).toBe("42");
  });

  // Nested widening — migrated from apply-types.spec.ts's "literal collapse"
  // applier sub-block. TS's getWidenedType widens literals recursively into
  // object properties, array/tuple elements, ref type-args, and fn signatures;
  // collapseLiteral mirrors that (the previous top-level-regex version let
  // nested literals survive even with the flag off).
  it("widens literals nested inside object properties", () => {
    expect(collapseLiteral('{ a: "yes", b: 42, c: true }', INFER_DEFAULTS)).toBe(
      "{ a: string, b: number, c: boolean }",
    );
  });

  it("widens literals inside an array element type", () => {
    expect(collapseLiteral('"yes"[]', INFER_DEFAULTS)).toBe("string[]");
  });

  it("widens literals inside tuple elements", () => {
    expect(collapseLiteral('["yes", 42, true]', INFER_DEFAULTS)).toBe("[string, number, boolean]");
  });

  it("widens literals inside ref type-arguments", () => {
    expect(collapseLiteral('Promise<"yes">', INFER_DEFAULTS)).toBe("Promise<string>");
  });

  it("widens literals inside function signatures", () => {
    expect(collapseLiteral('(x: "yes") => 42', INFER_DEFAULTS)).toBe("(x: string) => number");
  });

  it("does not widen nested literals when the flag is on", () => {
    expect(collapseLiteral('{ a: "yes" }', litOn)).toBe('{ a: "yes" }');
  });
});

describe("splitTopLevelUnion", () => {
  it("splits a top-level union into its members", () => {
    expect(splitTopLevelUnion("string | number")).toEqual(["string", "number"]);
  });

  it("does not split unions nested inside generic arguments", () => {
    expect(splitTopLevelUnion("Map<string | number, boolean>")).toEqual([
      "Map<string | number, boolean>",
    ]);
  });
});

describe("parseObjectType", () => {
  it("parses a flat object literal into a field → type map", () => {
    const parsed = parseObjectType("{ a: number, b: string }");
    expect(parsed).not.toBeNull();
    expect([...parsed!]).toEqual([
      ["a", "number"],
      ["b", "string"],
    ]);
  });

  it("returns null for a non-object type", () => {
    expect(parseObjectType("string")).toBeNull();
  });

  // Superset contract — also parses declaration-style object types (what the
  // TypeChecker's typeToString emits, consumed by verify.ts): semicolon
  // separators and no-space colons, with readonly modifiers kept in the key.
  // ts-capture's own emitted format (comma + `: `) is covered above.
  it("parses a semicolon-separated declaration-style object type", () => {
    expect([...parseObjectType("{ a: number; b: string }")!]).toEqual([
      ["a", "number"],
      ["b", "string"],
    ]);
  });

  it("parses a no-space colon", () => {
    expect([...parseObjectType("{ a:number }")!]).toEqual([["a", "number"]]);
  });

  it("keeps semicolon-separated complex value types intact", () => {
    expect([...parseObjectType("{ fn: () => void; x: number }")!]).toEqual([
      ["fn", "() => void"],
      ["x", "number"],
    ]);
  });

  it("keeps a readonly modifier in the key (stripped by the caller, not the parser)", () => {
    expect([...parseObjectType("{ readonly a: number }")!]).toEqual([["readonly a", "number"]]);
  });
});

describe("mergeTypes — object-merge variations", () => {
  // Migrated from apply-types.spec.ts's "merging object types for optional
  // properties" applier block: these pin mergeObjectTypes directly instead of
  // through a full applyTypesToFile round-trip. (Outputs verified against the
  // former end-to-end annotations.) Disjoint shapes and same-key value unions
  // are covered by the mergeTypes block above.
  const merge = (types: string[]) => mergeTypes(types, INFER_DEFAULTS);

  it("marks a non-shared key optional when merging overlapping shapes", () => {
    expect(merge(["{ age: number, name: string }", "{ name: string }"])).toEqual([
      "{ age?: number, name: string }",
    ]);
  });

  it("marks keys optional by observation frequency across three shapes", () => {
    expect(
      merge(["{ a: number, b: string, c: boolean }", "{ a: number, b: string }", "{ a: number }"]),
    ).toEqual(["{ a: number, b?: string, c?: boolean }"]);
  });

  it("marks every key optional when none appears in all observations", () => {
    expect(merge(["{ a: number }", "{ b: string }", "{ a: number, b: string }"])).toEqual([
      "{ a?: number, b?: string }",
    ]);
  });

  it("preserves a non-object member alongside the merged object", () => {
    expect(merge(["{ name: string }", "null", "{ name: string, age: number }"])).toEqual([
      "null",
      "{ age?: number, name: string }",
    ]);
  });

  it("leaves a single object shape unchanged", () => {
    expect(merge(["{ name: string }"])).toEqual(["{ name: string }"]);
  });

  it("dedups two structurally identical object shapes", () => {
    expect(merge(["{ age: number, name: string }", "{ age: number, name: string }"])).toEqual([
      "{ age: number, name: string }",
    ]);
  });

  it("merges three empty objects into one", () => {
    expect(merge(["{}", "{}", "{}"])).toEqual(["{}"]);
  });

  it("treats an empty object as making a populated object's keys optional", () => {
    expect(merge(["{}", "{ name: string }"])).toEqual(["{ name?: string }"]);
  });

  it("keeps a nested object value when its key becomes optional", () => {
    expect(merge(["{ data: { x: number }, name: string }", "{ name: string }"])).toEqual([
      "{ data?: { x: number }, name: string }",
    ]);
  });

  it("keeps a deeply nested object value verbatim", () => {
    expect(
      merge([
        "{ config: { db: { host: string, port: number } }, name: string }",
        "{ name: string }",
      ]),
    ).toEqual(["{ config?: { db: { host: string, port: number } }, name: string }"]);
  });

  it("keeps an array value type when its key becomes optional", () => {
    expect(merge(["{ items: string[], name: string }", "{ name: string }"])).toEqual([
      "{ items?: string[], name: string }",
    ]);
  });

  it("keeps a generic (Map) value type when its key becomes optional", () => {
    expect(merge(["{ cache: Map<string, number>, id: string }", "{ id: string }"])).toEqual([
      "{ cache?: Map<string, number>, id: string }",
    ]);
  });

  it("keeps a function value type when its key becomes optional", () => {
    expect(merge(["{ handler: (x: any) => any, name: string }", "{ name: string }"])).toEqual([
      "{ handler?: (x: any) => any, name: string }",
    ]);
  });

  it("preserves quoted keys through the merge", () => {
    expect(merge(['{ "content-type": string, status: number }', "{ status: number }"])).toEqual([
      '{ "content-type"?: string, status: number }',
    ]);
  });
});

describe("mergeTypes — discriminator detection (TS-aligned)", () => {
  // Migrated from apply-types.spec.ts's "discriminated union detection" applier
  // block. mergeObjectTypes mirrors TS's discriminant rule (src/compiler/
  // types.ts:6129 — Discriminant = HasNonUniformType | HasLiteralType): it bails
  // to a flat union only when a shared key carries a literal type. Outputs
  // verified against the former end-to-end annotations.
  it("merges when shared-key types differ but none are literal", () => {
    expect(
      mergeTypes(
        ["{ kind: number, value: number }", "{ kind: string, items: string[] }"],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ items?: string[], kind: number | string, value?: number }"]);
  });

  it("bails to a flat union when a shared key has literal types", () => {
    expect(
      mergeTypes(['{ kind: "a", value: number }', '{ kind: "b", items: string[] }'], litOn),
    ).toEqual(['{ kind: "a", value: number }', '{ kind: "b", items: string[] }']);
  });

  it("bails when one shared-key value is literal and the other is widened", () => {
    expect(
      mergeTypes(['{ kind: "a", value: number }', "{ kind: string, items: string[] }"], litOn),
    ).toEqual(['{ kind: "a", value: number }', "{ kind: string, items: string[] }"]);
  });

  it("merges `variant: undefined` vs `variant: string` with a non-shared key", () => {
    expect(
      mergeTypes(
        [
          "{ variant: undefined, size: number, label: string }",
          "{ variant: string, size: number }",
        ],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ label?: string, size: number, variant: string | undefined }"]);
  });

  it("merges overlapping shapes when shared keys agree (extra key optional)", () => {
    expect(
      mergeTypes(
        ["{ id: number, name: string, email: string }", "{ id: number, name: string }"],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ email?: string, id: number, name: string }"]);
  });

  it("merges three shapes when no shared-key value is literal", () => {
    expect(
      mergeTypes(
        [
          "{ type: number, x: number }",
          "{ type: string, y: string }",
          "{ type: boolean, z: boolean }",
        ],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ type: boolean | number | string, x?: number, y?: string, z?: boolean }"]);
  });

  it("bails on a three-shape discriminator with a literal `kind`", () => {
    const merged = mergeTypes(
      ['{ kind: "a", x: number }', '{ kind: "b", y: string }', '{ kind: "c", z: boolean }'],
      litOn,
    );
    expect(merged.length).toBeGreaterThan(1);
    expect(merged.every((m) => !m.includes("?"))).toBe(true);
  });

  it("treats scientific-notation literal numbers as discriminators", () => {
    expect(mergeTypes(["{ kind: 1e+21, x: number }", "{ kind: 2e+21, y: string }"], litOn)).toEqual(
      ["{ kind: 1e+21, x: number }", "{ kind: 2e+21, y: string }"],
    );
  });

  it("bails on identical-keyset literal-kind discriminators", () => {
    expect(mergeTypes(['{ kind: "a", v: number }', '{ kind: "b", v: number }'], litOn)).toEqual([
      '{ kind: "a", v: number }',
      '{ kind: "b", v: number }',
    ]);
  });

  it("merges identical-keyset non-literal kinds (regression)", () => {
    expect(
      mergeTypes(["{ kind: number, v: string }", "{ kind: string, v: number }"], INFER_DEFAULTS),
    ).toEqual(["{ kind: number | string, v: number | string }"]);
  });

  it("merges when all shared keys agree even though some keys differ", () => {
    expect(
      mergeTypes(
        ["{ id: number, name: string, age: number }", "{ id: number, name: string }"],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ age?: number, id: number, name: string }"]);
  });
});

describe("mergeTypes — recursive object merge", () => {
  // Migrated from apply-types.spec.ts's "recursive object merge (Path C)"
  // sub-block. Nested object values are merged recursively (rather than kept as
  // a flat union of shapes) unless recursiveObjectMerge is off or a nested
  // shared key is a literal discriminator. Outputs verified end-to-end.
  it("recursively merges nested object values of the same shape", () => {
    expect(
      mergeTypes(
        ["{ config: { value: string } }", "{ config: { value: number } }"],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ config: { value: number | string } }"]);
  });

  it("recursively merges three-deep variations", () => {
    expect(
      mergeTypes(
        [
          "{ config: { value: string } }",
          "{ config: { value: number } }",
          "{ config: { value: symbol } }",
        ],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ config: { value: number | string | symbol } }"]);
  });

  it("preserves optional keys in the recursive merge", () => {
    expect(
      mergeTypes(
        ["{ config: { a: number } }", "{ config: { a: number, b: string } }"],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ config: { a: number, b?: string } }"]);
  });

  it("merges nested overlapping keys to optional + required", () => {
    expect(
      mergeTypes(
        [
          "{ payload: { kind: string, value: number } }",
          "{ payload: { kind: string, items: string[] } }",
        ],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ payload: { items?: string[], kind: string, value?: number } }"]);
  });

  it("emits valid optional method-shape syntax (`render?(...)`)", () => {
    expect(
      mergeTypes(
        ["{ name: string, render(arg: unknown): unknown }", "{ name: string }"],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ name: string, render?(arg: unknown): unknown }"]);
  });

  it("recursively merges when a nested shared key has non-literal differing types", () => {
    expect(
      mergeTypes(
        [
          "{ payload: { kind: number, value: number } }",
          "{ payload: { kind: string, items: string[] } }",
        ],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ payload: { items?: string[], kind: number | string, value?: number } }"]);
  });

  it("does not recurse when values mix object and non-object types", () => {
    expect(mergeTypes(["{ value: { x: number } }", "{ value: string }"], INFER_DEFAULTS)).toEqual([
      "{ value: string | { x: number } }",
    ]);
  });

  it("an empty `{}` observation no longer forces a discriminator bail", () => {
    expect(
      mergeTypes(["{ addressType: string }", "{ addressType: undefined }", "{}"], INFER_DEFAULTS),
    ).toEqual(["{ addressType?: string | undefined }"]);
  });

  it("reverts to a flat nested union when recursiveObjectMerge is off", () => {
    expect(
      mergeTypes(["{ config: { value: string } }", "{ config: { value: number } }"], {
        ...INFER_DEFAULTS,
        recursiveObjectMerge: false,
      }),
    ).toEqual(["{ config: { value: number } | { value: string } }"]);
  });

  it("dedups identical nested-object observations", () => {
    expect(
      mergeTypes(["{ value: { x: number } }", "{ value: { x: number } }"], INFER_DEFAULTS),
    ).toEqual(["{ value: { x: number } }"]);
  });

  it("strips @sa chain markers from nested values without collapsing (flag off)", () => {
    expect(
      mergeTypes(
        ["{ payload: Cat /* @sa:Mammal|Animal */ }", "{ payload: Dog /* @sa:Mammal|Animal */ }"],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ payload: Cat | Dog }"]);
  });

  it("collapses @sa-marked nested values to their common base when rewriteCommonBase is on", () => {
    expect(
      mergeTypes(
        ["{ payload: Cat /* @sa:Mammal|Animal */ }", "{ payload: Dog /* @sa:Mammal|Animal */ }"],
        { ...INFER_DEFAULTS, rewriteCommonBase: true },
      ),
    ).toEqual(["{ payload: Mammal }"]);
  });

  it("falls back to a flat union when a nested shared key is a literal discriminator", () => {
    const merged = mergeTypes(
      ['{ payload: { kind: "a", value: number } }', '{ payload: { kind: "b", items: string[] } }'],
      litOn,
    );
    expect(merged.some((m) => m.includes("payload:"))).toBe(true);
    expect(merged.some((m) => /\{ kind: "a", value: number \}/.test(m))).toBe(true);
    expect(merged.some((m) => /\{ kind: "b", items: string\[\] \}/.test(m))).toBe(true);
  });
});

describe("mergeTypes — cross-sample array merge", () => {
  // Migrated from apply-types.spec.ts's "cross-sample array merge" sub-block.
  // The basic on/off behavior is covered by the mergeTypes block above; these
  // pin the multi-type, dedup, Array<>-merge, unknown-filtering, and
  // mixed-with-non-array variants. Note the native return order here is
  // unsorted — the applier sorts the final union (see the apply-types.spec.ts
  // end-to-end anchor).
  const xArr: InferOptions = { ...INFER_DEFAULTS, crossSampleArrayMerge: true };

  it("merges three or more different element types", () => {
    expect(mergeTypes(["number[]", "string[]", "boolean[]"], xArr)).toEqual([
      "Array<boolean | number | string>",
    ]);
  });

  it("dedups identical array observations without Array<> wrapping", () => {
    expect(mergeTypes(["number[]", "number[]"], xArr)).toEqual(["number[]"]);
  });

  it("merges T[] with an existing Array<U | V>", () => {
    expect(mergeTypes(["number[]", "Array<string | boolean>"], xArr)).toEqual([
      "Array<boolean | number | string>",
    ]);
  });

  it("filters unknown[] as carrying no element-type info", () => {
    expect(mergeTypes(["unknown[]", "string[]"], xArr)).toEqual(["string[]"]);
  });

  it("leaves a non-array observation in its own union slot", () => {
    expect(mergeTypes(["number[]", "string[]", "boolean"], xArr)).toEqual([
      "boolean",
      "Array<number | string>",
    ]);
  });
});

describe("mergeTypes — cartesian-product collapse inside Array<...>", () => {
  // Migrated from apply-types.spec.ts. A same-keyset object union inside an
  // Array<...> is collapsed to field-level unions (the 4-way { a, b } product
  // becomes one shape with union-typed fields). A single variant is left
  // unchanged; a shared non-literal key still merges to optional fields rather
  // than a wrong required-key merge.
  it("collapses a same-keyset object union into field-level unions", () => {
    expect(
      mergeTypes(
        [
          "Array<{ a: null, b: null } | { a: null, b: number } | { a: number, b: null } | { a: number, b: number }>",
        ],
        INFER_DEFAULTS,
      ),
    ).toEqual(["{ a: null | number, b: null | number }[]"]);
  });

  it("leaves a single element-type variant unchanged", () => {
    expect(mergeTypes(["Array<{ a: string }>"], INFER_DEFAULTS)).toEqual(["Array<{ a: string }>"]);
  });

  it("merges a shared non-literal `kind` element union to optional fields, not a wrong required merge", () => {
    const merged = mergeTypes(
      ["Array<{ kind: string, x: number } | { kind: string, y: string }>"],
      INFER_DEFAULTS,
    );
    expect(merged).toEqual(["{ kind: string, x?: number, y?: string }[]"]);
    expect(merged.every((m) => !/x: number, y: string/.test(m))).toBe(true);
  });
});

describe("mergeTypes — lub fallback", () => {
  // Migrated from apply-types.spec.ts's "lub fallback" block. When the legacy
  // object-merge bails on a literal discriminator AND infer.lubFallback is on, a
  // structural least-upper-bound is attempted: a shared keyset merges to one
  // shape (the discriminator becomes a literal union); truly disjoint shapes
  // collapse to `unknown`. With the flag off the bail stands. (The diagnostic
  // polymorphic-position marker on the `unknown` output is applier-level — see
  // the apply-types.spec.ts e2e anchor.)
  const litBail: InferOptions = {
    ...INFER_DEFAULTS,
    literal: { ...INFER_DEFAULTS.literal, string: true },
  };
  const litLub: InferOptions = { ...litBail, lubFallback: true };

  it("leaves the legacy bail as a flat union when lubFallback is off", () => {
    expect(mergeTypes(['{ kind: "a", v: number }', '{ kind: "b", v: number }'], litBail)).toEqual([
      '{ kind: "a", v: number }',
      '{ kind: "b", v: number }',
    ]);
  });

  it("recovers a shared-keyset bail into one structural shape", () => {
    expect(mergeTypes(['{ kind: "a", v: number }', '{ kind: "b", v: number }'], litLub)).toEqual([
      '{ kind: "a" | "b", v: number }',
    ]);
  });

  it("collapses truly disjoint shapes to unknown", () => {
    expect(
      mergeTypes(["{ a: number }", "{ b: string }"], { ...INFER_DEFAULTS, lubFallback: true }),
    ).toEqual(["unknown"]);
  });

  it("does not consult lub when the legacy merge already succeeds", () => {
    const obs = ["{ a: number, b: string }", "{ a: number }"];
    expect(mergeTypes(obs, { ...INFER_DEFAULTS, lubFallback: true })).toEqual(
      mergeTypes(obs, INFER_DEFAULTS),
    );
  });
});

describe("mergeTypes — built-in shape recognition", () => {
  // Migrated from apply-types.spec.ts. mergeTypes runs a recognizer post-pass
  // that rewrites a structural fingerprint matching a well-known built-in
  // (Promise, Map, …) to its named ref. Gated by infer.recognizeBuiltinShapes;
  // a shape missing a required key stays structural.
  it("rewrites a Promise-like structural shape to Promise<unknown>", () => {
    expect(
      mergeTypes(
        ["{ then: (cb: unknown) => unknown, catch: (cb: unknown) => unknown }"],
        INFER_DEFAULTS,
      ),
    ).toEqual(["Promise<unknown>"]);
  });

  it("rewrites a Map-like structural shape to Map<unknown, unknown>", () => {
    expect(
      mergeTypes(
        [
          "{ get: (k: unknown) => unknown, set: (k: unknown, v: unknown) => unknown, has: (k: unknown) => unknown, delete: (k: unknown) => unknown, size: number }",
        ],
        INFER_DEFAULTS,
      ),
    ).toEqual(["Map<unknown, unknown>"]);
  });

  it("leaves the shape structural when recognizeBuiltinShapes is off", () => {
    expect(
      mergeTypes(["{ then: (cb: unknown) => unknown, catch: (cb: unknown) => unknown }"], {
        ...INFER_DEFAULTS,
        recognizeBuiltinShapes: false,
      }),
    ).toEqual(["{ then: (cb: unknown) => unknown, catch: (cb: unknown) => unknown }"]);
  });

  it("leaves a Promise-like shape missing a required key structural", () => {
    expect(mergeTypes(["{ then: (cb: unknown) => unknown }"], INFER_DEFAULTS)).toEqual([
      "{ then: (cb: unknown) => unknown }",
    ]);
  });
});
