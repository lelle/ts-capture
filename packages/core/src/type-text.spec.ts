import { describe, expect, it } from "vitest";

import { typeText, unionArms } from "./type-text.js";

describe("typeText", () => {
  it("is undefined for a string that is not a type", () => {
    expect(typeText("{ this is not a type")).toBeUndefined();
    expect(typeText("")).toBeUndefined();
    expect(typeText("{ a: string; ... 8 more ...; z: string; }")).toBeUndefined();
  });

  it("spells two writings of one type the same", () => {
    expect(typeText("string|undefined")?.canonical).toBe(typeText("undefined | string")?.canonical);
    expect(typeText("{ b: number, a: string }")?.canonical).toBe("{ a: string; b: number }");
  });

  it("keeps the text it was given", () => {
    expect(typeText("string|undefined")?.source).toBe("string|undefined");
  });

  it("gives a union's arms as written, each a type of its own", () => {
    const arms = typeText("(A | B)[] | { f: () => void } | 'x'")?.arms;
    expect(arms?.map((arm) => arm.source)).toEqual(["(A | B)[]", "{ f: () => void }", "'x'"]);
    expect(arms?.[2]?.literal).toBe(true);
  });

  it("gives a type that is not a union as its own single arm", () => {
    expect(typeText("Map<string | number, boolean>")?.arms.map((arm) => arm.source)).toEqual([
      "Map<string | number, boolean>",
    ]);
  });

  it("names the leftmost identifier of every reference it must resolve", () => {
    expect(typeText("React.ReactElement | typeof Widget | Map<string, Foo>")?.references).toEqual(
      new Set(["React", "Widget", "Map", "Foo"]),
    );
  });

  it.each([['"a"'], ["'a'"], ["42"], ["-3.5"], ["1e+21"], ["true"], ["false"]])(
    "reads %s as a literal type",
    (text) => {
      expect(typeText(text)?.literal).toBe(true);
    },
  );

  it.each([["string"], ["null"], ["undefined"], ['"a" | "b"'], ["`a${string}`"]])(
    "does not read %s as one literal type",
    (text) => {
      expect(typeText(text)?.literal).toBe(false);
    },
  );
});

describe("unionArms", () => {
  it.each([
    ["string | number", ["string", "number"]],
    ["string|number", ["string", "number"]],
    ["Map<string | number, boolean>", ["Map<string | number, boolean>"]],
    ["{ f: () => void } | string", ["{ f: () => void }", "string"]],
    ["string | (() => void) | number", ["string", "(() => void)", "number"]],
    ["(A | B)", ["(A | B)"]],
    ['"a|b" | string', ['"a|b"', "string"]],
  ])("splits %s at its top-level unions", (text, arms) => {
    expect(unionArms(text)).toEqual(arms);
  });

  // The class-chain marker separates ancestors with `|`: a comment, not a union.
  it("keeps a comment with the arm it follows", () => {
    expect(unionArms("Cat /* @sa:Mammal|Animal */ | Dog /* @sa:Mammal|Animal */")).toEqual([
      "Cat /* @sa:Mammal|Animal */",
      "Dog /* @sa:Mammal|Animal */",
    ]);
  });

  // The checker's printer elides a long type as `... 8 more ...`, which does not
  // parse; its top-level arms are still there to split.
  it("splits text that is not a type at the unions outside brackets, quotes and comments", () => {
    expect(
      unionArms('{ a: () => string | number; ... 8 more ...; } | "x|y" | /* p|q */ Foo'),
    ).toEqual(["{ a: () => string | number; ... 8 more ...; }", '"x|y"', "/* p|q */ Foo"]);
  });
});
