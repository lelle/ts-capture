import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isRedundantAnnotation, widenedTypeString } from "./redundant-annotation.js";

// Boundary spec for the checker-backed redundancy oracle. Builds an in-memory
// Program (no tmpdir, no tsconfig on disk) and asks the checker what it infers
// at a named binding, then compares against what ts-capture would emit.

const FILE = "t.ts";

function program(source: string): { checker: ts.TypeChecker; sf: ts.SourceFile } {
  const host: ts.CompilerHost = {
    getSourceFile: (name, lang) =>
      name === FILE
        ? ts.createSourceFile(name, source, lang, true)
        : ts.sys.fileExists(name)
          ? ts.createSourceFile(name, ts.sys.readFile(name)!, lang, true)
          : undefined,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => {},
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  };
  const prog = ts.createProgram([FILE], { noImplicitAny: false, strict: false }, host);
  return { checker: prog.getTypeChecker(), sf: prog.getSourceFile(FILE)! };
}

/** Type the checker infers at the binding named `name`. */
function typeOf(source: string, name: string): { checker: ts.TypeChecker; type: ts.Type } {
  const { checker, sf } = program(source);
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = checker.getTypeAtLocation(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`no binding named ${name}`);
  return { checker, type: found };
}

/** Return type the checker infers for the function declaration `name`. */
function returnTypeOf(source: string, name: string): { checker: ts.TypeChecker; type: ts.Type } {
  const { checker, sf } = program(source);
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = checker.getSignatureFromDeclaration(node)?.getReturnType();
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`no function named ${name}`);
  return { checker, type: found };
}

describe("widenedTypeString", () => {
  it("widens a string literal to its base type", () => {
    const { checker, type } = typeOf(`const a = "lit";`, "a");
    expect(checker.typeToString(type)).toBe('"lit"');
    expect(widenedTypeString(checker, type)).toBe("string");
  });

  it("widens a numeric literal to its base type", () => {
    const { checker, type } = typeOf(`const a = 5;`, "a");
    expect(widenedTypeString(checker, type)).toBe("number");
  });

  // getBaseTypeOfLiteralType leaves `unique symbol` alone, so this is the one
  // case that needs an explicit flag check.
  it("widens a unique symbol to `symbol`", () => {
    const { checker, type } = typeOf(`const a = Symbol("s");`, "a");
    expect(checker.typeToString(type)).toBe("unique symbol");
    expect(widenedTypeString(checker, type)).toBe("symbol");
  });

  it("leaves an already-widened type alone", () => {
    const { checker, type } = typeOf(`const a = [1, 2];`, "a");
    expect(widenedTypeString(checker, type)).toBe("number[]");
  });
});

describe("isRedundantAnnotation — suppressed", () => {
  it.each([
    ['const a = "lit";', "a", "string"],
    ["const a = 5;", "a", "number"],
    ["const a = true;", "a", "boolean"],
    ['const a = Symbol("s");', "a", "symbol"],
    ["const a = [1, 2];", "a", "number[]"],
    ['function g(): string { return "x"; }\nconst a = g();', "a", "string"],
  ])("%s → %s adds nothing", (source, name, emitted) => {
    const { checker, type } = typeOf(source, name);
    expect(isRedundantAnnotation(checker, type, emitted)).toBe(true);
  });

  it("suppresses a return type the body already implies", () => {
    const { checker, type } = returnTypeOf(`function f() { return "x"; }`, "f");
    expect(isRedundantAnnotation(checker, type, "string")).toBe(true);
  });

  it("suppresses a contextually typed Array.prototype callback param", () => {
    const source = `const xs: string[] = [];\nxs.map(v => v.length);`;
    const { checker, type } = typeOf(source, "v");
    expect(isRedundantAnnotation(checker, type, "string")).toBe(true);
  });
});

describe("isRedundantAnnotation — annotation still lands", () => {
  // The regression guard against over-suppression: these are the positions
  // ts-capture exists to fill, and the cases where the run genuinely knows
  // more than the checker.
  it("does not suppress an implicit-any parameter", () => {
    const { checker, type } = typeOf(`function f(p) { return p; }\nf("x");`, "p");
    expect(checker.typeToString(type)).toBe("any");
    expect(isRedundantAnnotation(checker, type, "string")).toBe(false);
  });

  it("does not suppress a union wider than the checker's inference", () => {
    const { checker, type } = typeOf(`const a = "lit";`, "a");
    expect(isRedundantAnnotation(checker, type, "string | number")).toBe(false);
  });

  it("does not suppress when the emitted type is narrower", () => {
    const source = `function g(): string | number { return 1; }\nconst a = g();`;
    const { checker, type } = typeOf(source, "a");
    expect(isRedundantAnnotation(checker, type, "number")).toBe(false);
  });

  it("returns false with no checker, so callers fall back", () => {
    expect(isRedundantAnnotation(undefined, undefined, "string")).toBe(false);
  });
});

describe("isRedundantAnnotation — same type, different spelling", () => {
  // The checker's printer and ts-capture's own writer disagree on punctuation:
  // ` | ` against `|`, `; ` against `, `, and the printer sorts nothing. None of
  // that changes the type, so none of it may change the answer.
  it("suppresses a union ts-capture spells without spaces", () => {
    const source = `function g(f) { return f ? "s" : 1; }\nconst a = g(1);`;
    const { checker, type } = typeOf(source, "a");
    expect(widenedTypeString(checker, type)).toBe("string | number");
    expect(isRedundantAnnotation(checker, type, "string|number")).toBe(true);
  });

  it("suppresses a union whose arms are in the other order", () => {
    const source = `function g(f) { return f ? "s" : 1; }\nconst a = g(1);`;
    const { checker, type } = typeOf(source, "a");
    expect(isRedundantAnnotation(checker, type, "number|string")).toBe(true);
  });

  it("suppresses an object type separated by commas", () => {
    const { checker, type } = typeOf(`const a = { b: 1, c: "x" };`, "a");
    expect(checker.typeToString(type)).toBe("{ b: number; c: string; }");
    expect(isRedundantAnnotation(checker, type, "{ b: number, c: string }")).toBe(true);
  });

  it("suppresses an object type whose members are in the other order", () => {
    const { checker, type } = typeOf(`const a = { b: 1, c: "x" };`, "a");
    expect(isRedundantAnnotation(checker, type, "{ c: string, b: number }")).toBe(true);
  });

  it("suppresses an object type whose numeric key we quote", () => {
    const { checker, type } = typeOf(`const a = { 3: "x" };`, "a");
    expect(isRedundantAnnotation(checker, type, '{ "3": string }')).toBe(true);
  });

  // The printer elides a long object type as `... 8 more ...`, which matches
  // nothing. One such annotation on nestjs/nest — 22 fields, every one of them
  // already inferred — survived on that alone.
  it("suppresses an object type too long for the printer's default width", () => {
    const names = Array.from({ length: 30 }, (_, i) => `property${i}`);
    const props = names.map((n) => `${n}: "v"`).join(", ");
    const emitted = `{ ${names.map((n) => `${n}: string`).join(", ")} }`;
    const { checker, type } = typeOf(`const a = { ${props} };`, "a");
    expect(checker.typeToString(type)).toContain("more ...");
    expect(isRedundantAnnotation(checker, type, emitted)).toBe(true);
  });
});

describe("isRedundantAnnotation — spelling that does change the type", () => {
  it("does not suppress when a member is missing", () => {
    const { checker, type } = typeOf(`const a = { b: 1, c: "x" };`, "a");
    expect(isRedundantAnnotation(checker, type, "{ b: number }")).toBe(false);
  });

  it("does not suppress when readonly is dropped", () => {
    const { checker, type } = typeOf(`const a = { b: "x" } as const;`, "a");
    expect(checker.typeToString(type)).toBe('{ readonly b: "x"; }');
    expect(isRedundantAnnotation(checker, type, "{ b: string }")).toBe(false);
  });

  it("does not suppress when optionality is dropped", () => {
    const source = `declare const o: { b?: string };\nconst a = o;`;
    const { checker, type } = typeOf(source, "a");
    expect(isRedundantAnnotation(checker, type, "{ b: string }")).toBe(false);
  });

  it("does not suppress when a union arm is missing", () => {
    const source = `function g(f) { return f ? "s" : 1; }\nconst a = g(1);`;
    const { checker, type } = typeOf(source, "a");
    expect(isRedundantAnnotation(checker, type, "string")).toBe(false);
  });

  it("does not suppress an unparseable emitted string", () => {
    const { checker, type } = typeOf(`const a = { b: 1 };`, "a");
    expect(isRedundantAnnotation(checker, type, "{ b: number")).toBe(false);
  });
});
