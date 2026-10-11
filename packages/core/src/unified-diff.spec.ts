import { describe, expect, it } from "vitest";

import { unifiedDiff } from "./unified-diff.js";

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

describe("unifiedDiff", () => {
  it("shows a changed line between the lines around it", () => {
    const before = lines("const a = 1;", "function foo(x) {", "  return x;", "}");
    const after = lines("const a = 1;", "function foo(x: string) {", "  return x;", "}");

    expect(unifiedDiff("src/foo.ts", before, after)).toBe(
      lines(
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1,4 +1,4 @@",
        " const a = 1;",
        "-function foo(x) {",
        "+function foo(x: string) {",
        "   return x;",
        " }",
      ),
    );
  });

  it("says nothing about text that did not change", () => {
    const source = lines("const a = 1;");

    expect(unifiedDiff("a.ts", source, source)).toBe("");
  });

  it("keeps three lines of context and drops the rest", () => {
    const before = numbered(20);
    const after = [...before];
    after[9] = "line ten";

    expect(unifiedDiff("a.ts", lines(...before), lines(...after))).toBe(
      lines(
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -7,7 +7,7 @@",
        " line 7",
        " line 8",
        " line 9",
        "-line 10",
        "+line ten",
        " line 11",
        " line 12",
        " line 13",
      ),
    );
  });

  it("gives changes far apart a hunk each", () => {
    const before = numbered(30);
    const after = [...before];
    after[1] = "line two";
    after[27] = "line twenty-eight";

    const hunks = unifiedDiff("a.ts", lines(...before), lines(...after))
      .split("\n")
      .filter((line) => line.startsWith("@@"));

    expect(hunks).toEqual(["@@ -1,5 +1,5 @@", "@@ -25,6 +25,6 @@"]);
  });

  it("joins changes whose context would overlap into one hunk", () => {
    const before = numbered(20);
    const after = [...before];
    after[4] = "line five";
    after[9] = "line ten";

    const hunks = unifiedDiff("a.ts", lines(...before), lines(...after))
      .split("\n")
      .filter((line) => line.startsWith("@@"));

    expect(hunks).toEqual(["@@ -2,12 +2,12 @@"]);
  });

  it("counts an inserted line in the new range only", () => {
    const before = lines("import a from 'a';", "", "export const b = a;");
    const after = lines("import a from 'a';", "", "type B = string;", "export const b = a;");

    expect(unifiedDiff("a.ts", before, after)).toBe(
      lines(
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,3 +1,4 @@",
        " import a from 'a';",
        " ",
        "+type B = string;",
        " export const b = a;",
      ),
    );
  });
});
