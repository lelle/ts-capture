import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { CollectedTypeInfo } from "./type-collector.js";

import { isCompatible, verifyTypes } from "./verify.js";

describe("isCompatible", () => {
  describe("primitives", () => {
    it("string matches string", () => {
      expect(isCompatible(["string"], "string").verdict).toBe("match");
    });

    it("number does not match string", () => {
      expect(isCompatible(["number"], "string").verdict).toBe("mismatch");
    });

    it("boolean matches boolean", () => {
      expect(isCompatible(["boolean"], "boolean").verdict).toBe("match");
    });

    it("multiple observations all match", () => {
      expect(isCompatible(["string", "string"], "string").verdict).toBe("match");
    });

    it("any single observation that doesn't fit causes mismatch", () => {
      expect(isCompatible(["string", "number"], "string").verdict).toBe("mismatch");
    });
  });

  describe("unions", () => {
    it("string fits string | number", () => {
      expect(isCompatible(["string"], "string | number").verdict).toBe("match");
    });

    it("number fits string | number", () => {
      expect(isCompatible(["number"], "string | number").verdict).toBe("match");
    });

    it("boolean does not fit string | number", () => {
      expect(isCompatible(["boolean"], "string | number").verdict).toBe("mismatch");
    });

    it("both observed variants fit a union", () => {
      expect(isCompatible(["string", "number"], "string | number").verdict).toBe("match");
    });
  });

  describe("optional / nullable", () => {
    it("undefined fits string | undefined", () => {
      expect(isCompatible(["undefined"], "string | undefined").verdict).toBe("match");
    });

    it("null fits string | null", () => {
      expect(isCompatible(["null"], "string | null").verdict).toBe("match");
    });

    it("string fits string | undefined", () => {
      expect(isCompatible(["string"], "string | undefined").verdict).toBe("match");
    });
  });

  describe("arrays", () => {
    it("string[] matches string[]", () => {
      expect(isCompatible(["string[]"], "string[]").verdict).toBe("match");
    });

    it("number[] does not match string[]", () => {
      expect(isCompatible(["number[]"], "string[]").verdict).toBe("mismatch");
    });
  });

  describe("escape hatches", () => {
    it("any declared type bails as unverifiable", () => {
      expect(isCompatible(["string"], "any").verdict).toBe("unverifiable");
    });

    it("unknown declared type bails as unverifiable", () => {
      expect(isCompatible(["string"], "unknown").verdict).toBe("unverifiable");
    });

    it("structural object type matches when keys+types agree", () => {
      expect(isCompatible(["{ a: number }"], "{ a: number }").verdict).toBe("match");
    });

    it("structural object type with extra observed keys still matches (subtype)", () => {
      expect(isCompatible(["{ a: number, b: string }"], "{ a: number }").verdict).toBe("match");
    });

    it("structural object type missing required key flags mismatch", () => {
      expect(isCompatible(["{ b: string }"], "{ a: number }").verdict).toBe("mismatch");
    });

    it("structural object type optional key missing in observation is OK", () => {
      expect(isCompatible(["{ a: number }"], "{ a: number, b?: string }").verdict).toBe("match");
    });

    it("structural object type with type mismatch on shared key flags mismatch", () => {
      expect(isCompatible(["{ a: string }"], "{ a: number }").verdict).toBe("mismatch");
    });

    it("structural index signature bails as unverifiable", () => {
      expect(isCompatible(["{ x: number }"], "{ [key: string]: number }").verdict).toBe(
        "unverifiable",
      );
    });

    it("generic type bails as unverifiable", () => {
      expect(isCompatible(["string"], "Array<string>").verdict).toBe("unverifiable");
    });

    it("function-typed declaration matches function-typed observation", () => {
      // We can't compare param/return types deeply (observations are always
      // `unknown` there), but observed-fn vs declared-fn is a match.
      expect(isCompatible(["() => unknown"], "() => void").verdict).toBe("match");
    });

    it("function-typed declaration with non-function observation flags mismatch", () => {
      expect(isCompatible(["string"], "(x: number) => string").verdict).toBe("mismatch");
    });

    it("function-typed declaration with mixed observations flags mismatch", () => {
      expect(isCompatible(["() => unknown", "string"], "() => void").verdict).toBe("mismatch");
    });

    it("no observations bails as unverifiable", () => {
      expect(isCompatible([], "string").verdict).toBe("unverifiable");
    });
  });
});

describe("verifyTypes (integration with TS program)", () => {
  function buildProgramWithFile(
    content: string,
    filename = "test.ts",
  ): { program: ts.Program; absPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-verify-"));
    const absPath = path.join(dir, filename);
    fs.writeFileSync(absPath, content);
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        include: [filename],
      }),
    );
    const configPath = path.join(dir, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
    });
    return { program, absPath };
  }

  it("flags a parameter declared as string but observed as number", () => {
    const { program, absPath } = buildProgramWithFile(
      "export function add(a: string): string { return a + a; }\n",
    );
    const sf = program.getSourceFile(absPath)!;
    // Find position right after parameter name `a` (= where `: string` starts)
    const fn = sf.statements[0] as ts.FunctionDeclaration;
    const paramPos = (fn.parameters[0].name as ts.Identifier).getEnd();

    const typeInfo: CollectedTypeInfo = [
      [absPath, paramPos, [["number", undefined]], { fnRetPos: paramPos + 10 }],
    ];

    const report = verifyTypes(typeInfo, program);
    expect(report.totals.mismatch).toBe(1);
    expect(report.entries[0].declared).toBe("string");
    expect(report.entries[0].observed).toEqual(["number"]);
  });

  it("matches when observation agrees with declaration", () => {
    const { program, absPath } = buildProgramWithFile(
      "export function add(a: number): number { return a + a; }\n",
    );
    const sf = program.getSourceFile(absPath)!;
    const fn = sf.statements[0] as ts.FunctionDeclaration;
    const paramPos = (fn.parameters[0].name as ts.Identifier).getEnd();

    const typeInfo: CollectedTypeInfo = [
      [absPath, paramPos, [["number", undefined]], { fnRetPos: paramPos + 10 }],
    ];

    const report = verifyTypes(typeInfo, program);
    expect(report.totals.match).toBe(1);
    expect(report.totals.mismatch).toBe(0);
  });

  it("returns no-declaration when source file isn't in the program", () => {
    const { program } = buildProgramWithFile("export const x = 1;\n");
    const typeInfo: CollectedTypeInfo = [
      ["/tmp/nonexistent-1234567.ts", 10, [["string", undefined]], {}],
    ];
    const report = verifyTypes(typeInfo, program);
    expect(report.totals.noDeclaration).toBe(1);
  });

  it("flags a return-type mismatch", () => {
    const { program, absPath } = buildProgramWithFile(
      "export function f(a: number): boolean { return a > 0; }\n",
    );
    const sf = program.getSourceFile(absPath)!;
    const fn = sf.statements[0] as ts.FunctionDeclaration;
    // Return-type position: right after the closing `)` of the parameter list
    let returnPos = fn.parameters.end;
    while (sf.text[returnPos] !== ")") returnPos++;
    returnPos += 1;

    const typeInfo: CollectedTypeInfo = [
      [absPath, returnPos, [["string", undefined]], { returnType: true }],
    ];

    const report = verifyTypes(typeInfo, program);
    expect(report.totals.mismatch).toBe(1);
    expect(report.entries[0].declared).toBe("boolean");
    expect(report.entries[0].observed).toEqual(["string"]);
  });

  it("matches a return-type observation that agrees", () => {
    const { program, absPath } = buildProgramWithFile(
      "export function f(a: number): boolean { return a > 0; }\n",
    );
    const sf = program.getSourceFile(absPath)!;
    const fn = sf.statements[0] as ts.FunctionDeclaration;
    let returnPos = fn.parameters.end;
    while (sf.text[returnPos] !== ")") returnPos++;
    returnPos += 1;

    const typeInfo: CollectedTypeInfo = [
      [absPath, returnPos, [["boolean", undefined]], { returnType: true }],
    ];

    const report = verifyTypes(typeInfo, program);
    expect(report.totals.match).toBe(1);
  });

  it("returns unverifiable for any-typed declarations", () => {
    const { program, absPath } = buildProgramWithFile(
      "export function f(a: any): any { return a; }\n",
    );
    const sf = program.getSourceFile(absPath)!;
    const fn = sf.statements[0] as ts.FunctionDeclaration;
    const paramPos = (fn.parameters[0].name as ts.Identifier).getEnd();

    const typeInfo: CollectedTypeInfo = [
      [absPath, paramPos, [["string", undefined]], { fnRetPos: paramPos + 5 }],
    ];

    const report = verifyTypes(typeInfo, program);
    expect(report.totals.unverifiable).toBe(1);
    expect(report.entries[0].reason).toBe("declared any");
  });
});
