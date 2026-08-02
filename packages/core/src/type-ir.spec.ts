import { describe, expect, it } from "vitest";

import { isSubtype, lub, lubAll, parseType, serializeType, type TypeNode } from "./type-ir.js";

function lubStr(a: string, b: string): string {
  return serializeType(lub(parseType(a), parseType(b)));
}

function lubAllStr(inputs: string[]): string {
  return serializeType(lubAll(inputs.map(parseType)));
}

/**
 * The IR — round-trip + structural tests. The lub/subsumption tests
 * live alongside; this file establishes the foundation.
 */

describe("type-ir — parser + serializer round-trips", () => {
  // Round-trip: parse then serialise must produce the same string for
  // every shape the parser claims to recognise. Cases the parser
  // returns as `raw` round-trip verbatim by construction.
  it.each([
    "string",
    "number",
    "boolean",
    "undefined",
    "null",
    "unknown",
    "void",
    "never",
    "bigint",
    "symbol",
    '"foo"',
    '"with spaces"',
    "42",
    "-3.14",
    "true",
    "false",
  ])("round-trips primitive/literal: %s", (input) => {
    const node = parseType(input);
    expect(serializeType(node)).toBe(input);
  });

  it("round-trips arrays", () => {
    expect(serializeType(parseType("string[]"))).toBe("string[]");
    expect(serializeType(parseType("number[][]"))).toBe("number[][]");
  });

  it("normalises `Array<T>` to `T[]` for primitive element", () => {
    expect(serializeType(parseType("Array<string>"))).toBe("string[]");
    expect(serializeType(parseType("Array<number>"))).toBe("number[]");
  });

  it("keeps `Array<T>` form for union element (clearer than `(A | B)[]`)", () => {
    expect(serializeType(parseType("Array<boolean | string>"))).toBe("Array<boolean | string>");
  });

  it("round-trips object literals with sorted keys", () => {
    const node = parseType("{ b: number, a: string }");
    // Keys are alphabetised on serialise — stable diff output.
    expect(serializeType(node)).toBe("{ a: string, b: number }");
  });

  it("round-trips object literals with optional keys", () => {
    const node = parseType("{ src?: string }");
    expect(serializeType(node)).toBe("{ src?: string }");
  });

  it("preserves quoted numeric-string keys", () => {
    const node = parseType('{ "1": number, "10": number }');
    expect(serializeType(node)).toBe('{ "1": number, "10": number }');
  });

  it("round-trips tuples", () => {
    expect(serializeType(parseType("[string, number]"))).toBe("[string, number]");
    expect(serializeType(parseType("[]"))).toBe("[]");
  });

  it("round-trips function types", () => {
    expect(serializeType(parseType("(x: number) => string"))).toBe("(x: number) => string");
    expect(serializeType(parseType("(a: string, b: number) => boolean"))).toBe(
      "(a: string, b: number) => boolean",
    );
  });

  it("round-trips function with optional param", () => {
    const node = parseType("(x?: number) => void");
    expect(serializeType(node)).toBe("(x?: number) => void");
  });

  it("round-trips named generic refs", () => {
    expect(serializeType(parseType("Promise<string>"))).toBe("Promise<string>");
    expect(serializeType(parseType("Map<string, number>"))).toBe("Map<string, number>");
  });

  it("round-trips bare named refs (no args)", () => {
    expect(serializeType(parseType("MyInterface"))).toBe("MyInterface");
  });

  it("round-trips unions", () => {
    // Serialiser sorts + dedupes union members for diff stability.
    expect(serializeType(parseType("string | number"))).toBe("number | string");
    expect(serializeType(parseType("number | string | number"))).toBe("number | string");
  });

  it("flattens nested unions on parse", () => {
    const node = parseType("string | (number | boolean)");
    expect(node.tag).toBe("union");
    if (node.tag === "union") {
      expect(node.members).toHaveLength(3);
    }
  });

  it("nests object types via recursive parse", () => {
    const node = parseType("{ avatar: { src: string } }");
    expect(node.tag).toBe("object");
    if (node.tag === "object") {
      const avatar = node.required.get("avatar");
      expect(avatar?.tag).toBe("object");
      if (avatar?.tag === "object") {
        expect(avatar.required.get("src")?.tag).toBe("prim");
      }
    }
  });

  it("falls back to raw on unparseable input", () => {
    const node = parseType("@@gibberish");
    expect(node.tag).toBe("raw");
    expect(serializeType(node)).toBe("@@gibberish");
  });

  // Malformed numeric literals fall back to raw so
  // the parser's contract — non-raw node ⇒ round-trips as valid TS —
  // holds. The previous `[0-9.]+` loop accepted `1.2.3`, `2.`, etc.
  // Inputs starting with `.` go to a different parser branch (refOrPrim)
  // so they're not in scope here.
  it.each(["1.2.3", "2.", "-3..1"])(
    "falls back to raw on malformed number literal: %s",
    (input) => {
      const node = parseType(input);
      expect(node.tag).toBe("raw");
    },
  );

  // The TypeFormatFlags survey surfaced that our
  // serializer had no `InArrayType`/`InElementType`-equivalent
  // context tracking. Bare function types nested inside unions,
  // arrays, or tuples were emitted without the parens needed to
  // disambiguate the `=>` from surrounding syntax — producing
  // strings that TS would parse with the wrong precedence.

  it("function inside union wraps in parens", () => {
    // Without parens: `(a: string) => number | string` parses as
    // `(a: string) => (number | string)` — wrong precedence.
    const node = parseType("((a: string) => number) | string");
    const out = serializeType(node);
    expect(out).toBe("((a: string) => number) | string");
    // Round-trip must preserve structure.
    expect(serializeType(parseType(out))).toBe(out);
  });

  it("function inside array wraps in parens", () => {
    // Without parens: `(a: string) => number[]` parses as
    // `(a: string) => (number[])` — wrong: TS thinks the array
    // type is the return type, not the outer shape.
    const node = parseType("((a: string) => number)[]");
    const out = serializeType(node);
    expect(out).toBe("((a: string) => number)[]");
    expect(serializeType(parseType(out))).toBe(out);
  });

  it("two function types in a union both wrap", () => {
    const node = parseType("((a: string) => number) | ((b: number) => string)");
    const out = serializeType(node);
    expect(out).toBe("((a: string) => number) | ((b: number) => string)");
    expect(serializeType(parseType(out))).toBe(out);
  });

  // Tuple-element fn-paren wrap mirrors the
  // union-member and array-element cases. Implementation was already
  // in place at type-ir.ts:727+771; this test pins the contract so a
  // future change dropping the tuple-element branch from the wrap
  // condition would surface here.
  it("function type inside a tuple wraps in parens", () => {
    const node = parseType("[(a: string) => number, string]");
    const out = serializeType(node);
    // Without parens, `[() => void | string, ...]` parses as
    // `[() => (void | string), ...]` — the tuple element gets pulled
    // into the return type of the fn.
    expect(out).toBe("[((a: string) => number), string]");
    expect(serializeType(parseType(out))).toBe(out);
  });

  it("function with union return at TOP level does NOT need outer parens", () => {
    // `(a: string) => number | string` IS the intended form when
    // the union is the return type, not the surrounding union.
    // Parser produces a `fn` node with `union` return; serializer
    // at `top` ctx should not over-wrap.
    const node = parseType("(a: string) => number | string");
    expect(node.tag).toBe("fn");
    expect(serializeType(node)).toBe("(a: string) => number | string");
  });
});

describe("type-ir — isSubtype", () => {
  it("identity", () => {
    const a = parseType("string");
    expect(isSubtype(a, a)).toBe(true);
  });

  it("literal ⊆ base prim", () => {
    expect(isSubtype(parseType('"foo"'), parseType("string"))).toBe(true);
    expect(isSubtype(parseType("42"), parseType("number"))).toBe(true);
    expect(isSubtype(parseType("true"), parseType("boolean"))).toBe(true);
    // not the other way
    expect(isSubtype(parseType("string"), parseType('"foo"'))).toBe(false);
  });

  it("anything ⊆ unknown", () => {
    expect(isSubtype(parseType("string[]"), parseType("unknown"))).toBe(true);
    expect(isSubtype(parseType("{ a: number }"), parseType("unknown"))).toBe(true);
  });

  it("never ⊆ anything", () => {
    expect(isSubtype(parseType("never"), parseType("string"))).toBe(true);
  });

  it("array subsumption uses element relation", () => {
    expect(isSubtype(parseType("string[]"), parseType("Array<string>"))).toBe(true);
    expect(isSubtype(parseType("string[]"), parseType("Array<boolean | string>"))).toBe(true);
    expect(isSubtype(parseType("Array<boolean | string>"), parseType("string[]"))).toBe(false);
  });

  it("object with extra fields ⊆ object with fewer", () => {
    expect(isSubtype(parseType("{ a: number, b: string }"), parseType("{ a: number }"))).toBe(true);
    expect(isSubtype(parseType("{ a: number }"), parseType("{ a: number, b: string }"))).toBe(
      false,
    );
  });

  it("optional in target accepts absent in source", () => {
    expect(isSubtype(parseType("{ a: number }"), parseType("{ a: number, b?: string }"))).toBe(
      true,
    );
  });

  it("union ⊆ union: every member of a must be ⊆ some member of b", () => {
    expect(isSubtype(parseType("string | number"), parseType("string | number | boolean"))).toBe(
      true,
    );
    expect(isSubtype(parseType("string | boolean"), parseType("string | number"))).toBe(false);
  });
});

describe("type-ir — isSubtype regressions", () => {
  // The earlier isSubtype had no `fn`-tag case at all — every function-type
  // comparison returned false, including identity. Found by reading TS's
  // tests/cases/conformance/types/typeRelationships/subtypesAndSuperTypes
  // and running curated structural claims through our isSubtype.
  //
  // TS-rules for function types: contravariant params, covariant return,
  // same arity.

  it("function-type identity is a subtype of itself", () => {
    expect(isSubtype(parseType("(a: string) => number"), parseType("(a: string) => number"))).toBe(
      true,
    );
  });

  it("function-type covariant return widening", () => {
    expect(
      isSubtype(parseType("(a: string) => number"), parseType("(a: string) => number | string")),
    ).toBe(true);
  });

  it("function-type contravariant param widening (caller passes narrower)", () => {
    // A function accepting `string | number` is a subtype of one accepting only
    // `string` — callers passing strings are still served correctly.
    expect(
      isSubtype(parseType("(a: string | number) => number"), parseType("(a: string) => number")),
    ).toBe(true);
  });

  it("function-type contravariant param narrowing is NOT a subtype", () => {
    expect(
      isSubtype(parseType("(a: string) => number"), parseType("(a: string | number) => number")),
    ).toBe(false);
  });

  // Arity asymmetry per TS — a fn with FEWER params is
  // a subtype of one with MORE; the reverse is not.
  it("fewer-arity fn IS a subtype of more-arity fn (TS rule)", () => {
    // The canonical Array#map / Array#filter callback pattern: callbacks
    // declared with fewer params are assignable to slots expecting more.
    expect(
      isSubtype(parseType("(a: string) => number"), parseType("(a: string, b: number) => number")),
    ).toBe(true);
  });

  it("more-arity fn is NOT a subtype of fewer-arity fn", () => {
    // Reverse direction: b's caller supplies fewer args than a needs.
    expect(
      isSubtype(parseType("(a: string, b: number) => number"), parseType("(a: string) => number")),
    ).toBe(false);
  });

  // Optional-flag handling:
  it("required-param fn is NOT a subtype of optional-param fn", () => {
    // b-caller can skip the arg → a receives `undefined`, doesn't match
    // a's required `string` param.
    expect(isSubtype(parseType("(a: string) => void"), parseType("(a?: string) => void"))).toBe(
      false,
    );
  });

  it("optional-param fn IS a subtype of required-param fn", () => {
    // b-caller always supplies `string`, a accepts `string | undefined`
    // (effectively); no mismatch.
    expect(isSubtype(parseType("(a?: string) => void"), parseType("(a: string) => void"))).toBe(
      true,
    );
  });

  // Same root cause for `raw` nodes — the parser bails on method-shape,
  // intersection, and other shapes it doesn't model. Identity used to fail
  // because two `raw` nodes with identical text were never compared
  // structurally.

  it("method-shape identity (parsed as raw) is a subtype of itself", () => {
    expect(
      isSubtype(parseType("{ foo(x: string): number }"), parseType("{ foo(x: string): number }")),
    ).toBe(true);
  });

  it("intersection-type identity (parsed as raw) is a subtype of itself", () => {
    expect(
      isSubtype(parseType("string & { length: 4 }"), parseType("string & { length: 4 }")),
    ).toBe(true);
  });

  it("different raw texts are NOT subtypes (conservative — text-equality only)", () => {
    expect(
      isSubtype(parseType("{ foo(x: string): number }"), parseType("{ foo(x: number): number }")),
    ).toBe(false);
  });

  // Raw-vs-raw equality is whitespace-run-insensitive,
  // so dedupUnionMembers can collapse near-duplicate raw shapes that
  // differ only in interior spacing. We don't normalise OPERATOR
  // spacing (`A&B` vs `A & B`) — that would require parsing the raw
  // text, which defeats the point of raw nodes.
  it("whitespace-variant raw shapes are subtypes", () => {
    // Method-shape with method-key spacing differences inside the
    // brackets parses to identical object nodes (parser canonicalises
    // single-space gaps). Test the more interesting case: raw nodes
    // carrying multi-space runs in their captured text.
    const a = parseType("{ foo(x:   string): number }");
    const b = parseType("{ foo(x: string):    number }");
    expect(isSubtype(a, b)).toBe(true);
  });
});

describe("type-ir — TS-corpus subtype claims", () => {
  // A curated set of subtype claims extracted from TS compiler tests under
  // `tests/cases/conformance/types/typeRelationships/subtypesAndSuperTypes`.
  // Each claim lists the source file. These document our isSubtype against
  // TS's own structural-subtype contract for the cases our IR models
  // (primitives, literals, unions, arrays, tuples, objects, refs, fns).
  //
  // Claims that depend on TS features we don't model (class hierarchies,
  // intersection types beyond identity, recursive types, complex variance)
  // are intentionally omitted — those are documented limitations.

  const claims: Array<[string, string, boolean, string]> = [
    // stringLiteralTypeIsSubtypeOfString.ts
    ['"a"', "string", true, "stringLiteralTypeIsSubtypeOfString"],
    ['"a"', "any", true, "stringLiteralTypeIsSubtypeOfString"],
    ['"a"', "number", false, "stringLiteralTypeIsSubtypeOfString"],
    ['"a"', "boolean", false, "stringLiteralTypeIsSubtypeOfString"],

    // subtypesOfAny.ts (every type ⊆ any)
    ["string", "any", true, "subtypesOfAny"],
    ["{ foo: number }", "any", true, "subtypesOfAny"],
    ["string[]", "any", true, "subtypesOfAny"],

    // subtypingWithObjectMembersOptionality.ts (TS structural rule for optional fields)
    ["{ foo: string }", "{ foo?: string }", true, "subtypingWithObjectMembersOptionality"],
    ["{ foo?: string }", "{ foo: string }", false, "subtypingWithObjectMembersOptionality"],
    ["{}", "{ foo?: string }", true, "subtypingWithObjectMembersOptionality"],
    ["{}", "{ foo: string }", false, "subtypingWithObjectMembersOptionality"],

    // subtypingWithObjectMembers.ts (extra properties OK)
    ["{ foo: string, bar: number }", "{ foo: string }", true, "subtypingWithObjectMembers"],
    ["{ foo: string }", "{ foo: string, bar: number }", false, "subtypingWithObjectMembers"],

    // unionSubtypeIfEveryConstituentTypeIsSubtype.ts
    ["string | number", "string | number | boolean", true, "unionSubtype-grow"],
    ["string | number | boolean", "string | number", false, "unionSubtype-shrink"],
    ["string", "string | number", true, "single-to-union"],
    ["string | boolean", "string | number", false, "unionSubtype-mismatched"],
  ];

  for (const [sub, sup, expected, source] of claims) {
    const arrow = expected ? "⊆" : "⊄";
    it(`${sub} ${arrow} ${sup} (${source})`, () => {
      expect(isSubtype(parseType(sub), parseType(sup))).toBe(expected);
    });
  }
});

describe("type-ir — lub on the cases that motivated the IR", () => {
  it("nullable-field LUB on shared shape (the snapshot's dominant pattern)", () => {
    expect(lubStr("{ src: string }", "{ src: undefined }")).toBe("{ src: string | undefined }");
  });

  it("normalises Array<T> and T[] syntactic variants so subsumption applies", () => {
    // string[] ⊆ Array<boolean | string> — subsumption drops the
    // narrower, leaving the broader.
    expect(lubStr("string[]", "Array<boolean | string>")).toBe("Array<boolean | string>");
    expect(lubStr("Array<string>", "string[]")).toBe("string[]");
  });

  it("identical types lub to themselves", () => {
    expect(lubStr("string", "string")).toBe("string");
    expect(lubStr("{ a: number }", "{ a: number }")).toBe("{ a: number }");
  });

  it("zero-overlap object shapes fall to flat union (matches legacy mergeObjectTypes)", () => {
    // No shared keys → no anti-unifier exists in our model. The flat
    // union signal lets the verify oracle reject it downstream if
    // the assignment context can't accept a discriminated union.
    expect(lubStr("{ a: number }", "{ b: string }")).toBe("{ a: number } | { b: string }");
  });

  it("discriminated-union shapes lub via shared-key optional-merge (not flat union)", () => {
    // Shared `kind` key — lubObject can build an informative LUB. The
    // resulting `kind: "contact" | "task"` plus optional fields preserves
    // more info than a flat union; if the consuming position rejects
    // it, the verify oracle gates the actual emit.
    expect(lubStr('{ kind: "contact", name: string }', '{ kind: "task", title: string }')).toBe(
      '{ kind: "contact" | "task", name?: string, title?: string }',
    );
  });

  it("shared-key object lub: required becomes optional when missing in either side", () => {
    expect(lubStr("{ a: number, b: string }", "{ a: number }")).toBe("{ a: number, b?: string }");
  });

  it("recursive object lub on nested keys", () => {
    expect(lubStr("{ avatar: { src: string } }", "{ avatar: { src: undefined } }")).toBe(
      "{ avatar: { src: string | undefined } }",
    );
  });

  it("lub on Array<T> with same-name ref args: lubs the args", () => {
    expect(lubStr("Array<string>", "Array<number>")).toBe("Array<number | string>");
  });

  it("lub on Promise<T>: same-name generic ref", () => {
    expect(lubStr("Promise<string>", "Promise<number>")).toBe("Promise<number | string>");
  });

  it("lub of literal and base prim collapses to base", () => {
    expect(lubStr('"foo"', "string")).toBe("string");
    expect(lubStr("42", "number")).toBe("number");
  });

  it("lubAll over many observations matches react-admin snapshot pattern", () => {
    // Four observations differ only in two nullable-or-narrowed fields.
    const observations = [
      "{ acquisition: string, avatar: { src: string }, tags: number[] }",
      "{ acquisition: string, avatar: { src: undefined }, tags: unknown[] }",
      "{ acquisition: string, avatar: { src: undefined }, tags: number[] }",
      "{ acquisition: string, avatar: { src: string }, tags: unknown[] }",
    ];
    // `tags: number[]` ⊆ `tags: unknown[]` — subsumption collapses
    // the array to unknown[]; nested `src` becomes the LUB string | undefined.
    expect(lubAllStr(observations)).toBe(
      "{ acquisition: string, avatar: { src: string | undefined }, tags: unknown[] }",
    );
  });

  it("union member dedup: drops subsumed members", () => {
    expect(lubStr("string", "string | number")).toBe("number | string");
    expect(lubStr("string | number", "string | number")).toBe("number | string");
  });

  it("lubAll handles single-observation case", () => {
    expect(lubAllStr(["string"])).toBe("string");
    expect(lubAllStr(["{ a: number }"])).toBe("{ a: number }");
  });

  it("lub with unknown collapses to unknown", () => {
    expect(lubStr("string", "unknown")).toBe("unknown");
    expect(lubStr("{ a: number }", "unknown")).toBe("unknown");
  });

  it("lub on tuples of same arity is positional", () => {
    expect(lubStr("[string, number]", "[number, number]")).toBe("[number | string, number]");
  });

  it("lub on tuples of different arity falls to flat union", () => {
    expect(lubStr("[string, number]", "[string]")).toBe("[string, number] | [string]");
  });

  // Fn-type lub must produce a SUPERTYPE of both inputs (LUB
  // direction). Param positions are contravariant, so the LUB of two
  // fn-types' params is their GLB (intersection) — not the union. Without
  // a real intersection IR node, the only sound option is to flat-union
  // the two fn types instead of synthesising a wider-param fn.
  it("lub on disjoint-param fns falls to flat union", () => {
    // Was: synthesised `(a: number | string) => void` which is a SUBTYPE
    // of both inputs (wrong direction). Now: flat union, with each fn
    // wrapped in parens via the union-member context.
    expect(lubStr("(a: number) => void", "(a: string) => void")).toBe(
      "((a: number) => void) | ((a: string) => void)",
    );
  });

  it("lub on disjoint-return fns falls to flat union", () => {
    // Was: synthesised `(a: T) => string | number` via the now-removed
    // structural fn-lub case. Even though the return position is
    // covariant (lub-on-ret would be structurally sound), removing the
    // structural case is more honest until we have proper contravariant
    // param handling. Members are sorted lexicographically by the
    // serializer, so `number` sorts before `string`.
    expect(lubStr("(a: number) => string", "(a: number) => number")).toBe(
      "((a: number) => number) | ((a: number) => string)",
    );
  });

  it("lub of identical fns collapses via isSubtype (regression)", () => {
    // isSubtype's fn-case handles identical fns: both
    // directions return true, lub picks one. This must keep working
    // after the fn-lub case is removed.
    expect(lubStr("(a: number) => void", "(a: number) => void")).toBe("(a: number) => void");
  });

  // lubAll must be order-independent. foldLubBucket's earlier
  // left-fold-with-flush would miss compatible pairs separated by a
  // disjoint intermediate, making `lubAll([A,B,C])` ≠ `lubAll([A,C,B])`
  // when A and C share keys but B is disjoint from both.
  it("lubAll is order-independent across compatible+disjoint mixtures", () => {
    const A = "{ x: number }";
    const B = "{ y: string }"; // disjoint from A and C
    const C = "{ x: string }"; // shares key x with A
    // Both orderings should land on the same merged set:
    //   { x: number | string } (A∪C merged) plus B disjoint.
    expect(lubAllStr([A, B, C])).toBe(lubAllStr([A, C, B]));
    expect(lubAllStr([A, B, C])).toBe(lubAllStr([B, A, C]));
    expect(lubAllStr([A, B, C])).toBe(lubAllStr([C, B, A]));
  });
});

describe("type-ir — parser handles real react-admin observation shapes", () => {
  // Snapshot-derived: shapes that real observations have produced.
  // Each must parse to a real (non-raw) node — `raw` would defeat
  // lub later.

  it("parses the nullable-avatar shape (snapshot key case)", () => {
    const node = parseType("{ src: string }");
    expect(node.tag).toBe("object");
    const u: TypeNode = parseType("{ src: undefined }");
    expect(u.tag).toBe("object");
  });

  it("parses the broad contact shape with many fields", () => {
    const node = parseType(
      "{ acquisition: string, avatar: { src: string }, background: string, id: number }",
    );
    expect(node.tag).toBe("object");
    if (node.tag === "object") {
      expect(node.required.size).toBe(4);
    }
  });

  it("parses Array<boolean | string> as array(union(...))", () => {
    const node = parseType("Array<boolean | string>");
    expect(node.tag).toBe("array");
    if (node.tag === "array") {
      expect(node.element.tag).toBe("union");
    }
  });
});
