import { describe, expect, it } from "vitest";

import {
  decideVarDeclSite,
  suppressArrayCallbackStructural,
  type VarDeclFacts,
} from "./annotation-eligibility.js";

const clear: VarDeclFacts = {
  outerAnnotationSkip: false,
  isUnionProducingInitializer: false,
  hasOpaqueInitializer: false,
  hasType: false,
};

const decide = (
  facts: VarDeclFacts | undefined,
  obs = 1,
  firstUndef = false,
  ignoreExisting = false,
) => decideVarDeclSite(facts, obs, firstUndef, ignoreExisting);

describe("decideVarDeclSite", () => {
  it("delegates when the site is unknown (no facts)", () => {
    expect(decide(undefined)).toBe("delegate");
  });

  it("annotates a clean site", () => {
    expect(decide(clear)).toBe("annotate");
  });

  it("drops on an outer-annotation conflict (function RHS / type-args / generic)", () => {
    expect(decide({ ...clear, outerAnnotationSkip: true })).toBe("drop");
  });

  it("drops a union-producing initializer with a single observation, but not with two", () => {
    const facts = { ...clear, isUnionProducingInitializer: true };
    expect(decide(facts, 1)).toBe("drop");
    expect(decide(facts, 2)).toBe("annotate");
  });

  it("drops an opaque initializer only on a sole-undefined observation", () => {
    const facts = { ...clear, hasOpaqueInitializer: true };
    expect(decide(facts, 1, true)).toBe("drop");
    expect(decide(facts, 1, false)).toBe("annotate");
    expect(decide(facts, 2, true)).toBe("annotate");
  });

  it("reports idempotent for an already-typed site unless ignoreExistingTypes is on", () => {
    expect(decide({ ...clear, hasType: true }, 1, false, false)).toBe("idempotent");
    expect(decide({ ...clear, hasType: true }, 1, false, true)).toBe("annotate");
  });

  it("applies the rules in order — the outer-skip wins over a later guard", () => {
    expect(decide({ ...clear, outerAnnotationSkip: true, hasType: true })).toBe("drop");
  });
});

describe("suppressArrayCallbackStructural", () => {
  it("suppresses a structural annotation on an array-callback arrow", () => {
    expect(suppressArrayCallbackStructural(true, "{ a: number }")).toBe(true);
  });

  it("does not suppress when the position is not an array-callback arrow", () => {
    expect(suppressArrayCallbackStructural(false, "{ a: number }")).toBe(false);
  });

  it("does not suppress a primitive / named annotation (no structural shape)", () => {
    expect(suppressArrayCallbackStructural(true, "number")).toBe(false);
    expect(suppressArrayCallbackStructural(true, "Product")).toBe(false);
  });
});
