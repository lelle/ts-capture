import { describe, expect, it } from "vitest";

import { applyReplacements, Replacement } from "./replacement.js";

describe("Replacement", () => {
  describe("static factories", () => {
    it("creates an insert replacement at a position", () => {
      const r = Replacement.insert(5, ": string");
      expect(r.start).toBe(5);
      expect(r.end).toBe(5);
      expect(r.text).toBe(": string");
      expect(r.priority).toBe(0);
    });

    it("creates an insert with custom priority", () => {
      const r = Replacement.insert(5, ": string", 3);
      expect(r.priority).toBe(3);
    });

    it("creates a delete replacement for a range", () => {
      const r = Replacement.delete(2, 7);
      expect(r.start).toBe(2);
      expect(r.end).toBe(7);
      expect(r.text).toBe("");
    });
  });
});

describe("applyReplacements", () => {
  it("returns source unchanged for empty replacements", () => {
    expect(applyReplacements("hello world", [])).toBe("hello world");
  });

  it("inserts text at a single position", () => {
    // function foo(a) {}
    //               ^14 — insert ": number"
    const source = "function foo(a) {}";
    const result = applyReplacements(source, [Replacement.insert(14, ": number")]);
    expect(result).toBe("function foo(a: number) {}");
  });

  it("inserts at multiple non-overlapping positions", () => {
    // function foo(a, b) {}
    //               ^14   ^17
    const source = "function foo(a, b) {}";
    const replacements = [Replacement.insert(14, ": number"), Replacement.insert(17, ": string")];
    const result = applyReplacements(source, replacements);
    expect(result).toBe("function foo(a: number, b: string) {}");
  });

  it("handles insertions in any input order (sorts internally)", () => {
    const source = "function foo(a, b) {}";
    // Provide in reverse order — should still work
    const replacements = [Replacement.insert(17, ": string"), Replacement.insert(14, ": number")];
    const result = applyReplacements(source, replacements);
    expect(result).toBe("function foo(a: number, b: string) {}");
  });

  it("respects priority for insertions at the same position", () => {
    const source = "hello";
    // Two inserts at position 5, priority determines order
    const replacements = [Replacement.insert(5, " world", 1), Replacement.insert(5, "!", 0)];
    const result = applyReplacements(source, replacements);
    // Lower priority applied first (inserted at pos), higher priority then inserted before it
    expect(result).toBe("hello world!");
  });

  it("deletes a range of text", () => {
    const source = "function foo(a: number) {}";
    const result = applyReplacements(source, [Replacement.delete(14, 22)]);
    expect(result).toBe("function foo(a) {}");
  });

  it("handles mixed inserts and deletes", () => {
    const source = "function foo(a: string, b) {}";
    const replacements = [
      Replacement.delete(14, 22), // remove ": string"
      Replacement.insert(25, ": number"), // add ": number" after b
    ];
    const result = applyReplacements(source, replacements);
    expect(result).toBe("function foo(a, b: number) {}");
  });

  it("does not mutate the input array", () => {
    const source = "ab";
    const replacements = [Replacement.insert(1, "X"), Replacement.insert(0, "Y")];
    const original = [...replacements];
    applyReplacements(source, replacements);
    expect(replacements).toEqual(original);
  });

  it("handles insertion at start of string", () => {
    const result = applyReplacements("world", [Replacement.insert(0, "hello ")]);
    expect(result).toBe("hello world");
  });

  it("handles insertion at end of string", () => {
    const result = applyReplacements("hello", [Replacement.insert(5, " world")]);
    expect(result).toBe("hello world");
  });

  it("handles replacing a range with new text", () => {
    // General replacement: start !== end, text !== ""
    const source = "let x: any = 5;";
    const r = new Replacement(7, 10, "number");
    const result = applyReplacements(source, [r]);
    expect(result).toBe("let x: number = 5;");
  });
});
