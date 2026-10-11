import { createDefaultMapFromNodeModules } from "@typescript/vfs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { reachableLibs } from "./libs.js";
import { COMPILER_OPTIONS, runPlayground } from "./run.js";
import { STARTERS } from "./starters.js";

const libs = reachableLibs(
  createDefaultMapFromNodeModules(COMPILER_OPTIONS, ts),
  ["/lib.es2022.d.ts"],
);

function errorCount(code: string): number {
  const files = new Map(libs).set("/playground.ts", code);
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(COMPILER_OPTIONS),
    fileExists: (file) => files.has(file),
    readFile: (file) => files.get(file),
    getDefaultLibFileName: () => "/lib.es2022.d.ts",
    getSourceFile: (file, version) => {
      const text = files.get(file);
      return text === undefined
        ? undefined
        : ts.createSourceFile(file, text, version);
    },
  };
  const program = ts.createProgram(["/playground.ts"], COMPILER_OPTIONS, host);
  return ts.getPreEmitDiagnostics(program).length;
}

describe("runPlayground", () => {
  it("writes the observed types into the code it ran", async () => {
    const result = await runPlayground(
      `function label(user) {
  return user.name.toUpperCase();
}
label({ name: "Ada" });
`,
      libs,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toContain(
      "function label(user: { name: string }): string {",
    );
    expect(result.html).toContain("<ins>");
    expect(result.summary[0]).toBe("apply: 2 annotations written in 1 file.");
  });

  it("reports an annotation the type-check kept out, under the file's short name", async () => {
    const result = await runPlayground(
      `const pick = (items, key) => items.map((item) => item[key]);
pick([{ sku: "a", price: 2 }], "sku");
`,
      libs,
    );
    if (!result.ok) throw new Error(result.error);
    const report = result.report.join("\n");
    expect(report).toContain("Would add a type error");
    expect(report).toContain("    playground.ts:1:");
    expect(report).not.toContain("/playground.ts");
  });

  it("runs code that exports what it declares", async () => {
    const result = await runPlayground(
      `export function double(n) {\n  return n * 2;\n}\ndouble(2);\n`,
      libs,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toContain("export function double(n: number) {");
  });

  it("answers with the error when the code throws", async () => {
    const result = await runPlayground(
      `function fail() {\n  throw new Error("boom");\n}\nfail();\n`,
      libs,
    );
    expect(result).toEqual({ ok: false, error: "Error: boom" });
  });

  it("says so when nothing ran, instead of an empty result", async () => {
    const result = await runPlayground(
      `function unused(x) {\n  return x;\n}\n`,
      libs,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toBe(`function unused(x) {\n  return x;\n}\n`);
    expect(result.summary).toEqual([
      "Nothing was observed. Call your functions at the end of the file: the calls are what ts-capture learns from.",
    ]);
  });

  it.each(STARTERS)(
    "annotates the starter $title without adding a type error",
    async (starter) => {
      const result = await runPlayground(starter.code, libs);
      if (!result.ok) throw new Error(result.error);
      expect(result.after).not.toBe(starter.code);
      expect(errorCount(result.after)).toBeLessThanOrEqual(
        errorCount(starter.code),
      );
    },
  );
});
