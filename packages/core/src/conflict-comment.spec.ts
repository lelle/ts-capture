import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONFLICT_MARKER,
  conflictCommentText,
  isInsideTextRun,
  lineStartAndIndent,
  markerLineRanges,
  parseForNoteSafety,
  siteName,
} from "./conflict-comment.js";

describe("lineStartAndIndent", () => {
  it("finds the start of the line a position sits on", () => {
    const source = "const a = 1;\n  const b = 2;\n";
    const pos = source.indexOf("const b");
    expect(lineStartAndIndent(source, pos)).toEqual({ lineStart: 13, indent: "  " });
  });

  it("handles the first line", () => {
    expect(lineStartAndIndent("const a = 1;", 6)).toEqual({ lineStart: 0, indent: "" });
  });

  it("copies a tab indent verbatim", () => {
    const source = "if (x) {\n\t\tconst b = 2;\n}";
    expect(lineStartAndIndent(source, source.indexOf("const b")).indent).toBe("\t\t");
  });
});

describe("conflictCommentText", () => {
  const note = (name: string, observed: string[]) => ({
    name,
    observed,
    inferred: "string",
  });

  it("names the position, what the run saw, and what TypeScript infers", () => {
    expect(conflictCommentText([note("pattern", ["undefined"])], "")).toBe(
      "// @ts-capture: `pattern` observed `undefined`, TypeScript infers `string`\n",
    );
  });

  it("carries the indentation of the line it precedes", () => {
    expect(conflictCommentText([note("pattern", ["undefined"])], "    ")).toBe(
      "    // @ts-capture: `pattern` observed `undefined`, TypeScript infers `string`\n",
    );
  });

  // One line per conflict, in the order they were given — which is source
  // order, so the comments read left to right like the code beneath them.
  it("writes one line per conflict on the same source line", () => {
    expect(conflictCommentText([note("req", ["undefined"]), note("res", ["string[]"])], "")).toBe(
      "// @ts-capture: `req` observed `undefined`, TypeScript infers `string`\n" +
        "// @ts-capture: `res` observed `string[]`, TypeScript infers `string`\n",
    );
  });

  it("joins several unseen arms into one type", () => {
    expect(conflictCommentText([note("v", ["undefined", "string[]"])], "")).toBe(
      "// @ts-capture: `v` observed `undefined | string[]`, TypeScript infers `string`\n",
    );
  });
});

describe("markerLineRanges", () => {
  // Apply owns every line carrying the marker: it removes them all and writes
  // the ones that hold now, so a note whose conflict is gone — or whose code is
  // gone — does not survive to lie about the file.
  it("finds a marker line with its newline", () => {
    const source =
      "// @ts-capture: `a` observed `undefined`, TypeScript infers `string`\nconst a = f();\n";
    expect(markerLineRanges(source)).toEqual([[0, 69]]);
  });

  it("finds an indented marker line", () => {
    const source = "  // @ts-capture: x\n  const a = f();\n";
    expect(markerLineRanges(source)).toEqual([[0, 20]]);
  });

  it("finds several", () => {
    const source = "// @ts-capture: a\n// @ts-capture: b\nconst a = f();\n";
    expect(markerLineRanges(source)).toHaveLength(2);
  });

  it("leaves a human's prose alone", () => {
    const source = "// this is about @ts-capture but is not a marker\nconst a = f();\n";
    expect(markerLineRanges(source)).toEqual([]);
  });

  it("leaves a trailing marker-shaped comment alone — only whole lines are ours", () => {
    const source = "const a = f(); // @ts-capture: not a whole line\n";
    expect(markerLineRanges(source)).toEqual([]);
  });

  it("finds nothing in a file that has none", () => {
    expect(markerLineRanges("const a = 1;\n")).toEqual([]);
  });

  it("round-trips: stripping then writing reproduces the same file", () => {
    const body = "const pattern = getPattern();\n";
    const withNote =
      conflictCommentText([{ name: "pattern", observed: ["undefined"], inferred: "string" }], "") +
      body;
    const ranges = markerLineRanges(withNote);
    let stripped = withNote;
    for (const [start, end] of [...ranges].reverse()) {
      stripped = stripped.slice(0, start) + stripped.slice(end);
    }
    expect(stripped).toBe(body);
  });
});

describe("siteName", () => {
  const parse = (src: string) => ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
  const find = (sf: ts.SourceFile, pred: (n: ts.Node) => boolean): ts.Node => {
    let hit: ts.Node | undefined;
    const visit = (n: ts.Node): void => {
      if (!hit && pred(n)) hit = n;
      if (!hit) ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
    return hit!;
  };

  it("names a parameter", () => {
    const sf = parse("function f(req) {}");
    const node = find(sf, ts.isParameter);
    expect(siteName("param", node, sf)).toBe("req");
  });

  it("names a destructured parameter by its pattern", () => {
    const sf = parse("function f({ name, age }) {}");
    const node = find(sf, ts.isParameter);
    expect(siteName("param", node, sf)).toBe("{ name, age }");
  });

  it("names a variable declaration", () => {
    const sf = parse("const pattern = f();");
    const node = find(sf, ts.isVariableDeclaration);
    expect(siteName("varDecl", node, sf)).toBe("pattern");
  });

  it("names a return type by its function", () => {
    const sf = parse("function getUrl() { return 1; }");
    const node = find(sf, ts.isFunctionDeclaration);
    expect(siteName("returnType", node, sf)).toBe("getUrl return");
  });

  it("falls back to `return` for an anonymous function", () => {
    const sf = parse("const f = () => 1;");
    const node = find(sf, ts.isArrowFunction);
    expect(siteName("returnType", node, sf)).toBe("return");
  });
});

describe("CONFLICT_MARKER", () => {
  it("is the prefix the written comments actually carry", () => {
    const text = conflictCommentText(
      [{ name: "a", observed: ["undefined"], inferred: "string" }],
      "",
    );
    expect(text.trimStart().startsWith(CONFLICT_MARKER)).toBe(true);
  });
});

describe("isInsideTextRun", () => {
  const parse = (src: string) => ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);

  // A note goes in at the start of the line it describes. Inside a multi-line
  // template that start is inside the string: the comment becomes text, and its
  // backticks close the template early. Found by probing the applied output,
  // not by a test — nest has no annotation site inside a template.
  it("is true for a line start inside a multi-line template literal", () => {
    const src = "const s = `\n  ${items.map(x => x.id)}\n`;\n";
    const lineStart = src.indexOf("  ${");
    expect(isInsideTextRun(parse(src), lineStart)).toBe(true);
  });

  it("is true for a line start inside JSX text", () => {
    const src = "const el = (\n  <div>\n    {items.map(x => x.id)}\n  </div>\n);\n";
    // The extension decides: in a `.ts` file `<div>` is a type assertion.
    const sf = ts.createSourceFile("t.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(isInsideTextRun(sf, src.indexOf("    {items"))).toBe(true);
  });

  it("is false for an ordinary statement line", () => {
    const src = "function f() {\n  const a = 1;\n}\n";
    expect(isInsideTextRun(parse(src), src.indexOf("  const a"))).toBe(false);
  });

  it("is false for the line a template starts on", () => {
    const src = "const s = `\n  x\n`;\n";
    expect(isInsideTextRun(parse(src), 0)).toBe(false);
  });

  it("is false inside a template's interpolation, which is real code", () => {
    const src = "const s = `${\n  items.map(x => x.id)\n}`;\n";
    expect(isInsideTextRun(parse(src), src.indexOf("  items"))).toBe(false);
  });
});

describe("parseForNoteSafety", () => {
  // The extension is not cosmetic. `const f = <T>(v: T) => v;` is an ordinary
  // generic arrow in a `.ts` file; parsed as TSX the `<T>` opens a JSX element
  // and everything after it becomes JsxText. The check then refuses notes on
  // lines that were never inside a string — it cost a real one on nest.
  const SRC = "const f = <T>(v: T) => v;\nconst first = parts[0];\n";
  const lineStart = SRC.indexOf("const first");

  it("reads a .ts file as TypeScript, so a generic arrow stays code", () => {
    expect(isInsideTextRun(parseForNoteSafety("t.ts", SRC), lineStart)).toBe(false);
  });

  it("falls back to TypeScript when there is no filename", () => {
    expect(isInsideTextRun(parseForNoteSafety(undefined, SRC), lineStart)).toBe(false);
  });

  // The control: the same source read as TSX does invent the text run. Without
  // this, the two cases above pass against a parser that ignores the extension.
  it("reads a .tsx file as TSX", () => {
    expect(isInsideTextRun(parseForNoteSafety("t.tsx", SRC), lineStart)).toBe(true);
  });
});
