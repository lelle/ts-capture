import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONFLICT_MARKER,
  conflictCommentText,
  inlineNoteText,
  isInsideTextRun,
  lineStartAndIndent,
  markerLineRanges,
  markerSpanRanges,
  noteReplacements,
  parseForNoteSafety,
  previewCommentText,
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
      "// @ts-capture[conflict]: `pattern` observed `undefined`, TypeScript infers `string`\n",
    );
  });

  it("carries the indentation of the line it precedes", () => {
    expect(conflictCommentText([note("pattern", ["undefined"])], "    ")).toBe(
      "    // @ts-capture[conflict]: `pattern` observed `undefined`, TypeScript infers `string`\n",
    );
  });

  // One line per conflict, in the order they were given — which is source
  // order, so the comments read left to right like the code beneath them.
  it("writes one line per conflict on the same source line", () => {
    expect(conflictCommentText([note("req", ["undefined"]), note("res", ["string[]"])], "")).toBe(
      "// @ts-capture[conflict]: `req` observed `undefined`, TypeScript infers `string`\n" +
        "// @ts-capture[conflict]: `res` observed `string[]`, TypeScript infers `string`\n",
    );
  });

  it("joins several unseen arms into one type", () => {
    expect(conflictCommentText([note("v", ["undefined", "string[]"])], "")).toBe(
      "// @ts-capture[conflict]: `v` observed `undefined | string[]`, TypeScript infers `string`\n",
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

describe("previewCommentText — naming the position", () => {
  // One line can hold several sites: `const a = (s) => (d) => (e) => e;` has
  // three. Without a name the notes above it are indistinguishable — in `both`
  // mode they were literally identical strings.
  it("names each position", () => {
    const notes = [
      { name: "s", suggestion: "string", observations: 1, inferred: "any" },
      { name: "d", suggestion: "number", observations: 1, inferred: "any" },
    ];
    expect(previewCommentText(notes, "", "comments")).toBe(
      "// @ts-capture[proposal]: `s` would be `string`\n" +
        "// @ts-capture:   observed once; TypeScript infers `any`\n" +
        "// @ts-capture[proposal]: `d` would be `number`\n" +
        "// @ts-capture:   observed once; TypeScript infers `any`\n",
    );
  });

  it("names each position beside the annotation too", () => {
    const notes = [
      { name: "s", suggestion: "string", observations: 1, inferred: "any" },
      { name: "d", suggestion: "number", observations: 2, inferred: "any" },
    ];
    expect(previewCommentText(notes, "", "both")).toBe(
      "// @ts-capture[applied]: `s` observed once; TypeScript infers `any`\n" +
        "// @ts-capture[applied]: `d` observed 2 times; TypeScript infers `any`\n",
    );
  });
});

describe("previewCommentText — alongside an annotation", () => {
  // In `both` mode the annotation is written, so "would write" is a claim
  // about something that did happen — and the type it names is repeated
  // verbatim on the next line, which for a 156-character union is the whole
  // line twice. What the annotation does not say is why, so that is what is
  // left.
  it("says what the annotation cannot, and not what it already says", () => {
    expect(
      previewCommentText(
        [{ name: "v", suggestion: "string", observations: 5, inferred: "any" }],
        "",
        "both",
      ),
    ).toBe("// @ts-capture[applied]: `v` observed 5 times; TypeScript infers `any`\n");
  });

  it("still carries the indentation", () => {
    expect(
      previewCommentText([{ name: "v", suggestion: "string", observations: 1 }], "  ", "both"),
    ).toBe("  // @ts-capture[applied]: `v` observed once\n");
  });
});

describe("previewCommentText", () => {
  // The preview mode's comment. Two lines: what would be written, and the
  // context a reader needs to judge it without looking anything up.
  it("names the suggestion, the evidence, and what TypeScript has", () => {
    expect(
      previewCommentText(
        [{ name: "v", suggestion: "string", observations: 14, inferred: "any" }],
        "",
      ),
    ).toBe(
      "// @ts-capture[proposal]: `v` would be `string`\n" +
        "// @ts-capture:   observed 14 times; TypeScript infers `any`\n",
    );
  });

  // Singular reads as prose, and "observed once" is the number a reader should
  // stop at — not because one sighting is wrong, but because it is the case
  // where looking at *where* the value came from is worth the minute.
  it("says `once` rather than `1 times`", () => {
    expect(
      previewCommentText(
        [{ name: "v", suggestion: "string", observations: 1, inferred: "any" }],
        "",
      ),
    ).toContain("observed once;");
  });

  it("carries the indentation onto both lines", () => {
    expect(
      previewCommentText(
        [{ name: "v", suggestion: "string", observations: 2, inferred: "any" }],
        "  ",
      ),
    ).toBe(
      "  // @ts-capture[proposal]: `v` would be `string`\n" +
        "  // @ts-capture:   observed 2 times; TypeScript infers `any`\n",
    );
  });

  // No project, no checker, nothing to say about what TypeScript holds.
  it("drops the checker clause when there is no checker", () => {
    expect(previewCommentText([{ name: "v", suggestion: "string", observations: 3 }], "")).toBe(
      "// @ts-capture[proposal]: `v` would be `string`\n// @ts-capture:   observed 3 times\n",
    );
  });

  it("writes a block per suggestion on the same line", () => {
    const text = previewCommentText(
      [
        { name: "v", suggestion: "string", observations: 1, inferred: "any" },
        { name: "w", suggestion: "number", observations: 2, inferred: "any" },
      ],
      "",
    );
    expect(text.split("\n").filter(Boolean)).toHaveLength(4);
  });

  it("is stripped by the same mechanism that owns every note", () => {
    const text = previewCommentText([{ name: "v", suggestion: "string", observations: 1 }], "");
    expect(markerLineRanges(text + "const a = f();\n")).toHaveLength(2);
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

describe("inlineNoteText", () => {
  // A note at the site needs no name: the position identifies it. That is the
  // whole reason to put it there — `const a = (d) => (d) => (d) => null;` has
  // four positions and no way to tell them apart by name.
  it("names the type when nothing else will", () => {
    expect(
      inlineNoteText({ name: "return", suggestion: "void", observations: 1 }, "comments"),
    ).toBe("/* @ts-capture[proposal]: would be `void`; observed once */");
  });

  it("says only what the annotation cannot, beside one", () => {
    expect(
      inlineNoteText(
        { name: "return", suggestion: "void", observations: 3, inferred: "any" },
        "both",
      ),
    ).toBe("/* @ts-capture[applied]: observed 3 times; TypeScript infers `any` */");
  });

  it("carries the checker's view in comments mode too", () => {
    expect(
      inlineNoteText(
        { name: "x", suggestion: "string", observations: 2, inferred: "any" },
        "comments",
      ),
    ).toBe(
      "/* @ts-capture[proposal]: would be `string`; observed 2 times; TypeScript infers `any` */",
    );
  });
});

describe("markerSpanRanges", () => {
  // Inline notes are block comments, so their start and end are explicit and
  // removal takes exactly the comment. Whole-line notes stay the job of
  // `markerLineRanges`; this is the second path inline costs.
  it("finds an inline note", () => {
    const src = "const a = (d): void /* @ts-capture: observed once */ => d;\n";
    const [[start, end]] = markerSpanRanges(src);
    expect(src.slice(start, end)).toBe(" /* @ts-capture: observed once */");
  });

  it("finds several on one line", () => {
    const src = "const a = (d) /* @ts-capture: a */ => (e) /* @ts-capture: b */ => e;\n";
    expect(markerSpanRanges(src)).toHaveLength(2);
  });

  it("leaves a block comment that is not ours alone", () => {
    expect(markerSpanRanges("const a = 1; /* just a comment */\n")).toEqual([]);
  });

  it("round-trips: removing the spans restores the source", () => {
    const bare = "const a = (d): void => d;\n";
    const noted = "const a = (d): void /* @ts-capture: observed once */ => d;\n";
    let out = noted;
    for (const [start, end] of [...markerSpanRanges(noted)].reverse()) {
      out = out.slice(0, start) + out.slice(end);
    }
    expect(out).toBe(bare);
  });
});

describe("the note's state tag", () => {
  // Reading a diff, the `+` on the code line says whether an annotation was
  // written. Reading the file it is gone, and the signal becomes an annotation
  // that is *missing* — which is not something a reader spots. The tag says it,
  // and makes the findings greppable: 10 of nest's 135 notes are the ones to
  // act on.
  it("marks a contradiction", () => {
    const text = conflictCommentText(
      [{ name: "pattern", observed: ["undefined"], inferred: "string" }],
      "",
    );
    expect(text).toBe(
      "// @ts-capture[conflict]: `pattern` observed `undefined`, TypeScript infers `string`\n",
    );
  });

  it("marks a proposal", () => {
    expect(
      previewCommentText([{ name: "x", suggestion: "string", observations: 1 }], "", "comments"),
    ).toBe(
      "// @ts-capture[proposal]: `x` would be `string`\n" + "// @ts-capture:   observed once\n",
    );
  });

  it("marks what was written", () => {
    expect(
      previewCommentText([{ name: "x", suggestion: "string", observations: 1 }], "", "both"),
    ).toBe("// @ts-capture[applied]: `x` observed once\n");
  });

  it("marks an inline note too", () => {
    expect(inlineNoteText({ name: "return", suggestion: "void", observations: 1 }, "both")).toBe(
      "/* @ts-capture[applied]: observed once */",
    );
  });

  it("removes a tagged line like any other", () => {
    const src = "// @ts-capture[conflict]: `a` observed `undefined`\nconst a = f();\n";
    expect(markerLineRanges(src)).toEqual([[0, 51]]);
  });

  it("removes a tagged inline note like any other", () => {
    const src = "const a = (d) /* @ts-capture[applied]: observed once */ => d;\n";
    const [[start, end]] = markerSpanRanges(src);
    expect(src.slice(start, end)).toBe(" /* @ts-capture[applied]: observed once */");
  });
});

describe("the marker's boundary", () => {
  // `@ts-capture-ignore` is a directive the user writes. Matching the bare
  // prefix would have apply delete it — which the ignore-comment tests caught
  // the moment the tag loosened the marker.
  it("leaves an ignore directive alone", () => {
    expect(markerLineRanges("// @ts-capture-ignore\nconst a = f();\n")).toEqual([]);
  });

  it("leaves an inline ignore directive alone", () => {
    expect(markerSpanRanges("const a = f(); /* @ts-capture-ignore */\n")).toEqual([]);
  });

  it("still takes a bare note line, written before the tag existed", () => {
    expect(
      markerLineRanges("// @ts-capture: `a` observed `undefined`\nconst a = f();\n"),
    ).toHaveLength(1);
  });
});

describe("noteReplacements", () => {
  // The placement rule, in one place because two appliers need it. It lived in
  // the CST applier alone, so a pass-through entry on a crowded line came out
  // in the old ambiguous form — invisible until a project routes through the
  // second path, which nestjs/nest does not.
  const conflict = (pos: number, name: string) => ({
    pos,
    name,
    observed: ["undefined"],
    inferred: "string",
  });
  const preview = (pos: number, name: string) => ({
    pos,
    name,
    suggestion: "string",
    observations: 1,
  });
  const anywhere = () => true;

  it("puts a lone note above the line", () => {
    const out = noteReplacements({
      conflictNotes: new Map([[0, { indent: "", notes: [conflict(4, "a")] }]]),
      previewNotes: new Map(),
      outputMode: "annotations",
      canPlaceNoteAt: anywhere,
    });
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(0);
    expect(out[0].text).toContain("[conflict]: `a` observed");
  });

  it("puts two notes at their sites", () => {
    const out = noteReplacements({
      conflictNotes: new Map([[0, { indent: "", notes: [conflict(4, "a"), conflict(9, "b")] }]]),
      previewNotes: new Map(),
      outputMode: "annotations",
      canPlaceNoteAt: anywhere,
    });
    expect(out.map((r) => r.start)).toEqual([4, 9]);
    expect(out[0].text).toContain("/* @ts-capture[conflict]:");
  });

  // The case that put two formats on one line before contradictions joined the
  // count.
  it("counts a contradiction and an annotation together", () => {
    const out = noteReplacements({
      conflictNotes: new Map([[0, { indent: "", notes: [conflict(4, "a")] }]]),
      previewNotes: new Map([[0, { indent: "", notes: [preview(9, "b")] }]]),
      outputMode: "both",
      canPlaceNoteAt: anywhere,
    });
    expect(out.map((r) => r.start)).toEqual([4, 9]);
    for (const r of out) expect(r.text).toContain("/* @ts-capture[");
  });

  it("ignores previews when no preview mode is on", () => {
    const out = noteReplacements({
      conflictNotes: new Map([[0, { indent: "", notes: [conflict(4, "a")] }]]),
      previewNotes: new Map([[0, { indent: "", notes: [preview(9, "b")] }]]),
      outputMode: "annotations",
      canPlaceNoteAt: anywhere,
    });
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(0);
  });

  // Only the leading form needs the check: at a site the note sits where the
  // annotation would, which is code by definition.
  it("drops a lone note the line cannot carry", () => {
    const out = noteReplacements({
      conflictNotes: new Map([[0, { indent: "", notes: [conflict(4, "a")] }]]),
      previewNotes: new Map(),
      outputMode: "annotations",
      canPlaceNoteAt: () => false,
    });
    expect(out).toEqual([]);
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
