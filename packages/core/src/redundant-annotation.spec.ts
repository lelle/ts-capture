import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  carriesPolymorphicThis,
  discardsUnionArm,
  erasesEnum,
  erasesNamedType,
  isRedundantAnnotation,
  widenedTypeString,
  writesOverCallSignature,
} from "./redundant-annotation.js";

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

/** Return type the checker infers for the method `Class.name`. */
function methodReturnTypeOf(
  source: string,
  name: string,
): { checker: ts.TypeChecker; type: ts.Type } {
  const { checker, sf } = program(source);
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = checker.getSignatureFromDeclaration(node)?.getReturnType();
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`no method named ${name}`);
  return { checker, type: found };
}

describe("carriesPolymorphicThis", () => {
  // A builder that returns `this` keeps working in a subclass:
  // `class Sub extends Base {}; new Sub().with(x)` is a `Sub`. Writing the
  // base class name in that position hands every subclass caller a `Base`.
  // Eight nest methods were annotated that way — all builders.
  it("recognises a method that returns this", () => {
    const source = "class B { with(): this { return this; } }";
    const { checker, type } = methodReturnTypeOf(source, "with");
    expect(checker.typeToString(type)).toBe("this");
    expect(carriesPolymorphicThis(checker, type)).toBe(true);
  });

  it("recognises an inferred (unannotated) this return", () => {
    const source = "class B { with() { return this; } }";
    const { checker, type } = methodReturnTypeOf(source, "with");
    expect(carriesPolymorphicThis(checker, type)).toBe(true);
  });

  // `Promise<this>` is the ordinary shape of an async fluent API — a builder
  // that awaits cannot return `this` bare. The loss is the same: a run observes
  // `Promise<Base>` and every subclass caller gets a `Base` back.
  it("recognises this inside a type argument", () => {
    const source = "class B { async with(): Promise<this> { return this; } }";
    const { checker, type } = methodReturnTypeOf(source, "with");
    expect(checker.typeToString(type)).toBe("Promise<this>");
    expect(carriesPolymorphicThis(checker, type)).toBe(true);
  });

  it("recognises this as an array element", () => {
    const source = "class B { all(): this[] { return [this]; } }";
    const { checker, type } = methodReturnTypeOf(source, "all");
    expect(carriesPolymorphicThis(checker, type)).toBe(true);
  });

  it("recognises this inside a union", () => {
    const source = "class B { with(f) { return f ? this : undefined; } }";
    const { checker, type } = methodReturnTypeOf(source, "with");
    expect(carriesPolymorphicThis(checker, type)).toBe(true);
  });

  it("does not fire for a method returning the class by name", () => {
    const source = "class B { with(): B { return this; } }";
    const { checker, type } = methodReturnTypeOf(source, "with");
    expect(checker.typeToString(type)).toBe("B");
    expect(carriesPolymorphicThis(checker, type)).toBe(false);
  });

  it("does not fire for an ordinary return type", () => {
    const { checker, type } = returnTypeOf('function f() { return "x"; }', "f");
    expect(carriesPolymorphicThis(checker, type)).toBe(false);
  });

  it("returns false with no checker, so callers fall back", () => {
    expect(carriesPolymorphicThis(undefined, undefined)).toBe(false);
  });
});

describe("writesOverCallSignature", () => {
  // `Function` is a legitimate fallback when the run saw a function it could
  // not describe — a native one, say, that instrumentation never reached. It
  // is not legitimate on top of a signature TypeScript already knows: nest
  // types the `reject` of `new Promise((resolve, reject) => …)` as
  // `(reason?: any) => void`, and six sites wrote `Function` over it.
  it("refuses `Function` where the checker has a call signature", () => {
    const source = "const p = new Promise((resolve, reject) => reject());";
    const { checker, type } = typeOf(source, "reject");
    expect(checker.typeToString(type)).toContain("=>");
    expect(writesOverCallSignature(checker, type, "Function")).toBe(true);
  });

  it("refuses `Function[]` where the checker has an array of signatures", () => {
    const source = "const fns = [Date, RegExp];\nconst a = fns;";
    const { checker, type } = typeOf(source, "a");
    expect(writesOverCallSignature(checker, type, "Function[]")).toBe(true);
  });

  it("allows `Function` where the checker knows nothing", () => {
    const source = "function apply(fn) { return fn(5); }\napply(Math.floor);";
    const { checker, type } = typeOf(source, "fn");
    expect(checker.typeToString(type)).toBe("any");
    expect(writesOverCallSignature(checker, type, "Function")).toBe(false);
  });

  it("allows `Function` where the checker has a non-callable type", () => {
    const source = "const o = { a: 1 };\nconst x = o;";
    const { checker, type } = typeOf(source, "x");
    expect(writesOverCallSignature(checker, type, "Function")).toBe(false);
  });

  it("does not fire for an annotation that never mentions Function", () => {
    const source = "const p = new Promise((resolve, reject) => reject());";
    const { checker, type } = typeOf(source, "reject");
    expect(writesOverCallSignature(checker, type, "(reason?: string) => void")).toBe(false);
  });

  it("returns false with no checker, so callers fall back", () => {
    expect(writesOverCallSignature(undefined, undefined, "Function")).toBe(false);
  });
});

describe("erasesNamedType", () => {
  // A reader who sees `RouteInfo[]` knows where to look. A reader who sees the
  // expansion cannot tell whether it is complete — and on nest several were
  // not: one dropped a field, several turned an enum into `number`. 27 sites,
  // every one of them where TypeScript already had a type.
  it("fires when a named type becomes its structure", () => {
    const source =
      "interface RouteInfo { method: number; path: string }\ndeclare const r: RouteInfo[];\nconst a = r;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesNamedType(checker, type, "{ method: number, path: string }[]")).toBe(true);
  });

  it("fires when the name sits in a field of an anonymous object", () => {
    const source =
      "enum RequestMethod { Get }\ndeclare const o: { method: RequestMethod; path: string };\nconst a = o;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesNamedType(checker, type, "{ method: number, path: string }")).toBe(true);
  });

  // The other direction is the annotation worth keeping: nest's `server-kafka`
  // writes `ConsumerConfig` where TypeScript has the structure.
  it("does not fire when we write the name and TypeScript has the structure", () => {
    const source =
      "interface ConsumerConfig { groupId: string }\ndeclare const o: { groupId: string };\nconst a = o;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesNamedType(checker, type, "ConsumerConfig")).toBe(false);
  });

  it("does not fire when we write a primitive", () => {
    const source =
      "enum UuidFactoryMode { Random }\ndeclare const m: UuidFactoryMode;\nconst a = m;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesNamedType(checker, type, "string")).toBe(false);
  });

  it("does not fire when TypeScript names nothing", () => {
    const source = "declare const o: { a: string };\nconst a = o;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesNamedType(checker, type, "{ a: string, b: number }")).toBe(false);
  });

  it("does not fire when the checker has any", () => {
    const { checker, type } = typeOf("function f(p) { return p; }\nf(1);", "p");
    expect(erasesNamedType(checker, type, "{ a: string }")).toBe(false);
  });

  it("keeps the name when our annotation still mentions it", () => {
    const source = "interface Cat { legs: number }\ndeclare const c: Cat[];\nconst a = c;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesNamedType(checker, type, "{ pet: Cat }")).toBe(false);
  });

  it("returns false with no checker, so callers fall back", () => {
    expect(erasesNamedType(undefined, undefined, "{ a: string }")).toBe(false);
  });
});

describe("erasesEnum", () => {
  // An enum is a name with meaning attached. The run sees only what it is made
  // of — a string or a number — so writing the observation replaces
  // `UuidFactoryMode` with `string`, and every `mode === UuidFactoryMode.Random`
  // downstream stops meaning anything.
  it("fires when an enum becomes its underlying primitive", () => {
    const source = "enum Mode { A = 'a' }\ndeclare const m: Mode;\nconst a = m;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesEnum(checker, type, "string")).toBe(true);
  });

  // Wrapping does not change what is lost: `Promise<string>` over
  // `Promise<Mode>` costs every `mode === Mode.A` downstream exactly what the
  // bare case costs.
  it("fires when the enum sits in a type argument", () => {
    const source = "enum Mode { A = 'a' }\ndeclare const m: Promise<Mode>;\nconst a = m;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesEnum(checker, type, "Promise<string>")).toBe(true);
  });

  it("fires when the enum is an array element", () => {
    const source = "enum Mode { A = 'a' }\ndeclare const m: Mode[];\nconst a = m;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesEnum(checker, type, "string[]")).toBe(true);
  });

  it("fires when the enum sits in a union", () => {
    const source = "enum Scope { DEFAULT }\ndeclare const s: Scope | undefined;\nconst a = s;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesEnum(checker, type, "number|undefined")).toBe(true);
  });

  it("does not fire when the annotation keeps the enum", () => {
    const source = "enum Mode { A = 'a' }\ndeclare const m: Mode | undefined;\nconst a = m;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesEnum(checker, type, "Mode|undefined")).toBe(false);
  });

  // Deliberately narrow: an interface widened to a primitive is a different
  // loss, and `"a" | "b" | (string & {})` is not a name at all.
  it("does not fire for a non-enum named type", () => {
    const source = "interface Cat { legs: number }\ndeclare const c: Cat;\nconst a = c;";
    const { checker, type } = typeOf(source, "a");
    expect(erasesEnum(checker, type, "string")).toBe(false);
  });

  it("does not fire for a literal union that is not an enum", () => {
    const source = 'declare const e: "headers" | "topic";\nconst a = e;';
    const { checker, type } = typeOf(source, "a");
    expect(erasesEnum(checker, type, "string")).toBe(false);
  });

  it("returns false with no checker, so callers fall back", () => {
    expect(erasesEnum(undefined, undefined, "string")).toBe(false);
  });
});

describe("discardsUnionArm", () => {
  // Writing a type *narrower* than the checker's is the one failure mode that
  // introduces an error rather than removing one: nest's `server-grpc` writes
  // `string` where TypeScript has `string | symbol`, and it compiles only
  // because no caller at that site passes a symbol yet.
  it("fires when a payload arm is dropped", () => {
    const source = "declare const k: string | symbol;\nconst a = k;";
    const { checker, type } = typeOf(source, "a");
    expect(discardsUnionArm(checker, type, "string")).toBe(true);
  });

  // `?:` supplies the `undefined` itself, so dropping it is how an optional
  // parameter is meant to be written. Only payload arms count.
  it("does not fire when only a nullish arm is dropped", () => {
    const source = "declare const s: string | undefined;\nconst a = s;";
    const { checker, type } = typeOf(source, "a");
    expect(discardsUnionArm(checker, type, "string")).toBe(false);
  });

  it("does not fire when the annotation is wider", () => {
    const source = "declare const s: string;\nconst a = s;";
    const { checker, type } = typeOf(source, "a");
    expect(discardsUnionArm(checker, type, "string|undefined")).toBe(false);
  });

  it("does not fire when an arm is both dropped and added", () => {
    const source = "declare const k: string | symbol;\nconst a = k;";
    const { checker, type } = typeOf(source, "a");
    expect(discardsUnionArm(checker, type, "string|number")).toBe(false);
  });

  it("does not fire on an identical union spelled differently", () => {
    const source = "declare const k: string | symbol;\nconst a = k;";
    const { checker, type } = typeOf(source, "a");
    expect(discardsUnionArm(checker, type, "symbol|string")).toBe(false);
  });

  // Widening literals to their base adds an arm the checker did not have, so
  // it is not a discard — that case keeps its own verdict.
  it("does not fire when a literal union is widened to its base", () => {
    const source = 'declare const e: "a" | "b";\nconst a = e;';
    const { checker, type } = typeOf(source, "a");
    expect(discardsUnionArm(checker, type, "string")).toBe(false);
  });

  it("returns false with no checker, so callers fall back", () => {
    expect(discardsUnionArm(undefined, undefined, "string")).toBe(false);
  });
});
