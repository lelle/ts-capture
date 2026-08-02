import { describe, expect, it } from "vitest";

import { rewriteCommonBase, stripAllChainMarkers } from "./class-chain.js";
import { INFER_DEFAULTS, type InferOptions } from "./configuration.js";

// Boundary spec for the @sa class-chain collapse behind
// RewriteMostSpecificCommonBase. The runtime captures the prototype chain
// inline as a `@sa:` marker comment; rewriteCommonBase collapses an observed
// union of derived classes to their most-specific shared ancestor when the flag
// is on, and stripAllChainMarkers removes the internal markers (which must
// never leak into emitted source). Migrated from the
// "RewriteMostSpecificCommonBase" block of the 4,604-line apply-types.spec.ts.

const on: InferOptions = { ...INFER_DEFAULTS, rewriteCommonBase: true };
const off: InferOptions = { ...INFER_DEFAULTS, rewriteCommonBase: false };

describe("rewriteCommonBase — flag on", () => {
  it("collapses a class union to its most-specific shared ancestor", () => {
    expect(
      rewriteCommonBase(["Cat /* @sa:Mammal|Animal */", "Dog /* @sa:Mammal|Animal */"], on),
    ).toEqual(["Mammal"]);
  });

  it("collapses sibling subtrees to their deepest shared base", () => {
    expect(
      rewriteCommonBase(["Cat /* @sa:Mammal|Animal */", "Sparrow /* @sa:Bird|Animal */"], on),
    ).toEqual(["Animal"]);
  });

  it("keeps a flat union (markers stripped) when there is no shared ancestor", () => {
    expect(rewriteCommonBase(["Cat /* @sa:Animal */", "Daisy /* @sa:Plant */"], on)).toEqual([
      "Cat",
      "Daisy",
    ]);
  });

  it("does not widen a single observation — it only strips the marker", () => {
    expect(rewriteCommonBase(["Cat /* @sa:Animal */"], on)).toEqual(["Cat"]);
  });

  it("passes non-class primitives through unchanged", () => {
    expect(
      rewriteCommonBase(["Cat /* @sa:Animal */", "Dog /* @sa:Animal */", "string"], on),
    ).toEqual(["Animal", "string"]);
  });

  it("dedups repeated observations of the same class (no widening)", () => {
    expect(
      rewriteCommonBase(
        ["Cat /* @sa:Animal */", "Cat /* @sa:Animal */", "Cat /* @sa:Animal */"],
        on,
      ),
    ).toEqual(["Cat"]);
  });

  it("treats a malformed marker as an opaque type (no collapse, no strip)", () => {
    expect(rewriteCommonBase(["Cat /* not a chain */", "Dog /* not a chain */"], on)).toEqual([
      "Cat /* not a chain */",
      "Dog /* not a chain */",
    ]);
  });
});

describe("rewriteCommonBase — flag off", () => {
  it("keeps a flat union with markers stripped (no widening)", () => {
    expect(rewriteCommonBase(["Cat /* @sa:Animal */", "Dog /* @sa:Animal */"], off)).toEqual([
      "Cat",
      "Dog",
    ]);
  });
});

describe("stripAllChainMarkers", () => {
  it("strips a populated @sa marker, leaving the class name", () => {
    expect(stripAllChainMarkers("Cat /* @sa:Animal */")).toBe("Cat");
  });

  it("strips an empty @sa marker", () => {
    expect(stripAllChainMarkers("Standalone /* @sa: */")).toBe("Standalone");
  });

  it("strips a marker nested inside an object value", () => {
    expect(stripAllChainMarkers("{ pet: Cat /* @sa:Animal */ }")).toBe("{ pet: Cat }");
  });

  it("leaves a non-@sa comment untouched", () => {
    expect(stripAllChainMarkers("Cat /* not a chain */")).toBe("Cat /* not a chain */");
  });
});
