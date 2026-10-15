import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { CollectedTypeInfo } from "./type-collector.js";

import { instrumented } from "./test-utils/instrumented.js";
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

    it("function-typed declaration matches a value observed only as Function", () => {
      expect(isCompatible(["Function"], "(value: unknown) => void").verdict).toBe("match");
    });

    it("function-typed declaration with non-function observation flags mismatch", () => {
      expect(isCompatible(["string"], "(x: number) => string").verdict).toBe("mismatch");
    });

    it("function-typed declaration with mixed observations flags mismatch", () => {
      expect(isCompatible(["() => unknown", "string"], "() => void").verdict).toBe("mismatch");
    });

    it("any[] declared type bails as unverifiable like any", () => {
      expect(isCompatible(["string[]"], "any[]")).toEqual({
        verdict: "unverifiable",
        reason: "declared any",
      });
    });

    it("undefined observed matches a void return", () => {
      expect(isCompatible(["undefined"], "void")).toEqual({ verdict: "match" });
    });

    it("polymorphic this bails as unverifiable", () => {
      expect(isCompatible(["Account"], "this")).toEqual({
        verdict: "unverifiable",
        reason: "declared this",
      });
    });

    it("no observations bails as unverifiable", () => {
      expect(isCompatible([], "string").verdict).toBe("unverifiable");
    });
  });

  // Each of these was a false alarm on honojs/hono.
  describe("what an observation cannot contradict", () => {
    it.each([
      ["{ varIndex: number }", "Context"],
      ["RegExpRouter", "R"],
      ["() => Promise<Context>", "Next"],
      ["undefined", 'E["Bindings"]'],
      ["string", "Data | null"],
      ["(c: unknown) => unknown[]", "H[]"],
    ])("a named type: %s observed, %s declared", (observed, declared) => {
      expect(isCompatible([observed], declared)).toEqual({
        verdict: "unverifiable",
        reason: "named declared type",
      });
    });

    it.each([
      ["string", '"ws" | "http"'],
      ["number", "2 | 1 | 3"],
      ["boolean", "true"],
    ])("a literal type, which the run widens: %s observed, %s declared", (observed, declared) => {
      expect(isCompatible([observed], declared)).toEqual({
        verdict: "unverifiable",
        reason: "literal declared type",
      });
    });

    it("still flags a value no named arm could be when every arm is plain", () => {
      expect(isCompatible(["number"], '"ws" | "http" | boolean').verdict).toBe("mismatch");
    });
  });

  // The false alarms left on hono and nest after the first round.
  describe("functions and classes the text used to miss", () => {
    it("reads an observed method as a property holding a function", () => {
      expect(
        isCompatible(
          ["{ label: string, onInput(value: string): void }"],
          "{ label: string; onInput: (value: string) => void; }",
        ).verdict,
      ).toBe("match");
    });

    it("leaves an observed method against a named function type unverifiable, not a mismatch", () => {
      expect(
        isCompatible(
          ["{ buildSearchParams(query: unknown): unknown }"],
          "{ buildSearchParams: BuildSearchParamsFn; }",
        ).verdict,
      ).not.toBe("mismatch");
    });

    it("takes a function walked as an object, as a mock is, for a function", () => {
      expect(
        isCompatible(
          ["{ apply(...argsArray: unknown[]): unknown, bind(): unknown }"],
          "(...args: unknown[]) => unknown",
        ).verdict,
      ).toBe("match");
    });

    it("takes a class for a function", () => {
      expect(isCompatible(["typeof Test"], "(...args: unknown[]) => unknown").verdict).toBe(
        "match",
      );
    });

    it("cannot tell whether a class or a named instance has an object type's keys", () => {
      expect(isCompatible(["typeof WithMetadata"], "{ name: string; }")).toEqual({
        verdict: "unverifiable",
        reason: "named observed type",
      });
    });

    it("still flags a primitive against an object type", () => {
      expect(isCompatible(["null"], "{ name: string; }").verdict).toBe("mismatch");
    });
  });

  describe("arrays and objects the text used to miss", () => {
    it("a readonly array matches the same array observed", () => {
      expect(isCompatible(["string[]"], "readonly string[]").verdict).toBe("match");
    });

    it("an empty array, observed as unknown[], fits any array", () => {
      expect(isCompatible(["unknown[]", "string[]"], "string[]").verdict).toBe("match");
    });

    it("object fits any value that is not a primitive", () => {
      expect(isCompatible(["{ alg: string }", "{}", "Promise<unknown>"], "object").verdict).toBe(
        "match",
      );
    });

    it("object does not fit a primitive", () => {
      expect(isCompatible(["string"], "object").verdict).toBe("mismatch");
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

  it("locates an entry at the declaration name, one-based", () => {
    const { program, absPath } = buildProgramWithFile(
      "// first line\nexport function add(a: string): string { return a + a; }\n",
    );
    const sf = program.getSourceFile(absPath)!;
    const fn = sf.statements[0] as ts.FunctionDeclaration;
    const paramPos = (fn.parameters[0].name as ts.Identifier).getEnd();

    const typeInfo: CollectedTypeInfo = [
      [absPath, paramPos, [["number", undefined]], { fnRetPos: paramPos + 10 }],
    ];

    const report = verifyTypes(typeInfo, program);
    expect(report.entries[0]).toMatchObject({ line: 2, column: 21, name: "a" });
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

  describe("observations of written types", () => {
    const returnPosOf = (source: string, fn: string): number =>
      source.indexOf(")", source.indexOf(fn)) + 1;

    it("flags a written parameter and return type the run disagrees with", () => {
      const source = "function total(qty: string): string { return qty; }\n";
      const { program, absPath } = buildProgramWithFile(source);
      const observed = instrumented(source, {
        filename: absPath,
        options: { skipTscptrDeclarations: true, observeAnnotated: true },
      }).run({ total: [2] });

      const report = verifyTypes(observed.entries, program);

      expect(report.entries.map((e) => [e.name, e.declared, e.observed, e.verdict])).toEqual([
        ["qty", "string", ["number"], "mismatch"],
        ["return type", "string", ["number"], "mismatch"],
      ]);
    });

    it("matches a written type wider than what was observed", () => {
      const source = "export function f(name: string | null) { return name; }\n";
      const { program, absPath } = buildProgramWithFile(source);
      const typeInfo: CollectedTypeInfo = [
        [absPath, source.indexOf("name") + 4, [["string", undefined]], { annotated: true }],
      ];

      expect(verifyTypes(typeInfo, program).entries[0].verdict).toBe("match");
    });

    it("lets an optional parameter be undefined", () => {
      const source = "export function f(headers?: string) { return headers; }\n";
      const { program, absPath } = buildProgramWithFile(source);
      const typeInfo: CollectedTypeInfo = [
        [absPath, source.indexOf("headers?") + 8, [["undefined", undefined]], { annotated: true }],
      ];

      expect(verifyTypes(typeInfo, program).entries[0]).toMatchObject({
        declared: "string | undefined",
        verdict: "match",
      });
    });

    it("lets an optional callback be left out, and still checks what was passed", () => {
      const source = "export function f(onError?: (e: Error) => void) { return onError; }\n";
      const { program, absPath } = buildProgramWithFile(source);
      const passed = (observed: string): CollectedTypeInfo => [
        [absPath, source.indexOf("onError?") + 8, [[observed, undefined]], { annotated: true }],
      ];

      expect(verifyTypes(passed("undefined"), program).entries[0]).toMatchObject({
        declared: "((e: Error) => void) | undefined",
        verdict: "match",
      });
      expect(verifyTypes(passed("number"), program).entries[0].verdict).toBe("mismatch");
    });

    it("names a destructured parameter on one line", () => {
      const source =
        "export function f({\n  a,\n  b,\n}: { a: string; b: string }) { return a; }\n";
      const { program, absPath } = buildProgramWithFile(source);
      const typeInfo: CollectedTypeInfo = [
        [
          absPath,
          source.indexOf("}") + 1,
          [["{ a: string, b: string }", undefined]],
          { annotated: true },
        ],
      ];

      expect(verifyTypes(typeInfo, program).entries[0].name).toBe("{ a, b, }");
    });

    it("compares a destructured parameter with its written type", () => {
      const source = "export function f({ a }: { a: string }) { return a; }\n";
      const { program, absPath } = buildProgramWithFile(source);
      const typeInfo: CollectedTypeInfo = [
        [absPath, source.indexOf("}") + 1, [["{ a: number }", undefined]], { annotated: true }],
      ];

      expect(verifyTypes(typeInfo, program).entries[0]).toMatchObject({
        name: "{ a }",
        declared: "{ a: string; }",
        verdict: "mismatch",
      });
    });

    it("compares an async return with what its promise resolved to", () => {
      const source = "export async function load(): Promise<string> { return 'a'; }\n";
      const { program, absPath } = buildProgramWithFile(source);
      const returnOf = (observed: string): CollectedTypeInfo => [
        [
          absPath,
          returnPosOf(source, "load"),
          [[observed, undefined]],
          { returnType: true, async: true, annotated: true },
        ],
      ];

      expect(verifyTypes(returnOf("number"), program).entries[0]).toMatchObject({
        declared: "Promise<string>",
        verdict: "mismatch",
      });
      expect(verifyTypes(returnOf("string"), program).entries[0].verdict).toBe("match");
    });

    it("cannot verify an async return whose promise never settled", () => {
      const source = "export async function load(): Promise<string> { return 'a'; }\n";
      const { program, absPath } = buildProgramWithFile(source);
      const typeInfo: CollectedTypeInfo = [
        [
          absPath,
          returnPosOf(source, "load"),
          [["Promise", undefined]],
          { returnType: true, async: true, annotated: true },
        ],
      ];

      expect(verifyTypes(typeInfo, program).entries[0]).toMatchObject({
        verdict: "unverifiable",
        reason: "promise not settled",
      });
    });
  });

  it("finds the return of a paren-less arrow", () => {
    const source = "export const double = (n: number) => [n].map(x => x * 2);\n";
    const { program, absPath } = buildProgramWithFile(source);
    const typeInfo: CollectedTypeInfo = [
      [absPath, source.indexOf("x =>") + 1, [["number", undefined]], { returnType: true }],
    ];

    const [entry] = verifyTypes(typeInfo, program).entries;

    expect(entry).toMatchObject({ declared: "number", verdict: "match" });
  });
});
