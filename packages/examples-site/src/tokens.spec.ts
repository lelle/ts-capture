import { describe, expect, it } from "vitest";

import { markAdded, tokenize } from "./tokens.js";

const kinds = (code: string) =>
  tokenize(code)
    .filter((token) => token.kind !== "space")
    .map((token) => [token.text, token.kind]);

describe("tokenize", () => {
  it("gives back every character it was given", () => {
    const code =
      "  find(id) {\n    return this.orders.get(id); // lookup\n  }\n";

    expect(
      tokenize(code)
        .map((token) => token.text)
        .join(""),
    ).toBe(code);
  });

  it("tells keywords, type names, strings, numbers and comments apart", () => {
    expect(kinds('const n: number = 1; // one\nlet s = "a";')).toEqual([
      ["const", "keyword"],
      ["n", "name"],
      [":", "punctuation"],
      ["number", "type"],
      ["=", "punctuation"],
      ["1", "number"],
      [";", "punctuation"],
      ["// one", "comment"],
      ["let", "keyword"],
      ["s", "name"],
      ["=", "punctuation"],
      ['"a"', "string"],
      [";", "punctuation"],
    ]);
  });

  it("reads a fragment that starts in the middle of a class", () => {
    expect(kinds("  }\n\n  find(id) {")).toEqual([
      ["}", "punctuation"],
      ["find", "name"],
      ["(", "punctuation"],
      ["id", "name"],
      [")", "punctuation"],
      ["{", "punctuation"],
    ]);
  });

  it("keeps a template literal with a substitution together as string and code", () => {
    expect(kinds("throw new Error(`No ${sku} left`);")).toEqual([
      ["throw", "keyword"],
      ["new", "keyword"],
      ["Error", "name"],
      ["(", "punctuation"],
      ["`No ${", "string"],
      ["sku", "name"],
      ["} left`", "string"],
      [")", "punctuation"],
      [";", "punctuation"],
    ]);
  });
});

describe("markAdded", () => {
  const added = (before: string, after: string) =>
    markAdded(tokenize(before), tokenize(after))
      .filter((token) => token.added)
      .map((token) => token.text)
      .join("");

  it("marks an annotation and nothing around it", () => {
    expect(added("function f(a, b) {", "function f(a: string, b) {")).toBe(
      ": string",
    );
  });

  it("marks each of several annotations on a line", () => {
    const after = markAdded(
      tokenize("function f(a, b) {"),
      tokenize("function f(a: string, b: number): void {"),
    );

    expect(
      after
        .filter((token) => token.added && token.kind !== "space")
        .map((t) => t.text),
    ).toEqual([":", "string", ":", "number", ":", "void"]);
    expect(after.find((token) => token.text === ",")?.added).toBe(false);
  });

  it("marks the annotation, not the brace after it, when the type has braces of its own", () => {
    expect(added("find(id) {", "find(id: string): { id: string } {")).toBe(
      ": string: { id: string }",
    );
  });

  it("marks a whole added line, its comment included", () => {
    expect(added("const r = f();", "// note\nconst r = f();")).toBe(
      "// note\n",
    );
  });

  it("marks nothing when the code is the same", () => {
    expect(added("return a;", "return a;")).toBe("");
  });
});
