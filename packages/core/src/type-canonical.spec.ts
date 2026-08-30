import { describe, expect, it } from "vitest";

import { canonicalTypeString, sameTypeString, typeStringForSource } from "./type-canonical.js";

// Unit spec for the type-string canonicaliser. The boundary case — what the
// checker's printer actually emits against what ts-capture writes — lives in
// redundant-annotation.spec.ts, where a real Program answers it.

describe("canonicalTypeString", () => {
  it("returns undefined for a string that is not a type", () => {
    expect(canonicalTypeString("{ this is not a type")).toBeUndefined();
    expect(canonicalTypeString("")).toBeUndefined();
    expect(canonicalTypeString("{ a: string; ... 8 more ...; z: string; }")).toBeUndefined();
  });

  it("gives two spellings of one type the same form", () => {
    expect(canonicalTypeString("string|undefined")).toBe(canonicalTypeString("string | undefined"));
  });
});

describe("sameTypeString — punctuation and order do not make a type", () => {
  it.each([
    ["string|undefined", "string | undefined"],
    ["A|B", "B | A"],
    ["{ a: string, b: number }", "{ a: string; b: number; }"],
    ["{ b: number, a: string }", "{ a: string; b: number; }"],
    ['{ "3": RegExp, all: RegExp }', "{ 3: RegExp; all: RegExp; }"],
    ["(A|B)[]", "(B | A)[]"],
    ["Map<string,   number>", "Map<string, number>"],
    ["{ a: { c: number, b: string } }", "{ a: { b: string; c: number; }; }"],
    // A function type's identity does not include its parameter names, and its
    // parameter types are types like any other — both spellings below name one
    // type. Comparing the parameter list as raw text said otherwise.
    ["(a: string) => void", "(x: string) => void"],
    ["(a: { b: number, a: string }) => void", "(q: { a: string; b: number; }) => void"],
    ["() => { b: string, a: number }", "() => { a: number; b: string; }"],
  ])("%s is %s", (a, b) => {
    expect(sameTypeString(a, b)).toBe(true);
  });
});

describe("sameTypeString — differences that change the type", () => {
  it.each([
    ["{ a: string }", "{ readonly a: string }"],
    ["{ a?: string }", "{ a: string }"],
    ['"get"', "string"],
    ["string", "string | undefined"],
    ["{ a: string }", "{ a: string, b: number }"],
    ["string[]", "[string]"],
    ["Set<string>", "Set<number>"],
    ["Promise<unknown>", "Promise<any>"],
    // Arity, optionality and rest-ness are not spelling — each changes which
    // calls the type accepts, so each must survive canonicalisation.
    ["(a: string) => void", "(a: string, b: string) => void"],
    ["(a: string) => void", "(a?: string) => void"],
    ["(a: string[]) => void", "(...a: string[]) => void"],
    ["(a: string) => void", "(a: number) => void"],
  ])("%s is not %s", (a, b) => {
    expect(sameTypeString(a, b)).toBe(false);
  });

  // An unanswerable comparison must not be answered with a guess: an
  // unparseable side falls back to exact text equality, which suppresses
  // nothing that was not already identical.
  it("falls back to text equality when a side does not parse", () => {
    expect(sameTypeString("{ a: string", "{ a: string")).toBe(true);
    expect(sameTypeString("{ a: string", "{ a: string }")).toBe(false);
  });
});

describe("typeStringForSource", () => {
  it("spells separators the way TypeScript does", () => {
    expect(typeStringForSource("{ b: number|string, a: T }")).toBe("{ b: number | string; a: T }");
  });

  it("keeps parameter names, member order and union order", () => {
    expect(typeStringForSource("(value: string) => void")).toBe("(value: string) => void");
    expect(typeStringForSource("{ b: string, a: number }")).toBe("{ b: string; a: number }");
    expect(typeStringForSource("string|number")).toBe("string | number");
  });

  it("returns undefined for text that is not a type", () => {
    expect(typeStringForSource("... 8 more ...")).toBeUndefined();
  });

  it("leaves a type carrying a diagnostic note alone", () => {
    expect(typeStringForSource("unknown /* @ts-capture:polymorphic-position */")).toBeUndefined();
  });
});
