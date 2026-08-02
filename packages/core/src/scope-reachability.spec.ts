import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  allTypeRefsInScope,
  buildCtorArityMap,
  buildScopedTypeNames,
  buildScopedTypeNamesViaTypeChecker,
  expandCtorArity,
} from "./scope-reachability.js";

// Boundary spec for the scope-reachability heuristics — the allowlist, the
// import/same-file-decl scan, the PascalCase ref check, and the ctor-arity
// expansion. None had a dedicated spec; they were exercised only through the
// 4,604-line apply-types.spec.ts.

describe("buildScopedTypeNames (text path)", () => {
  it("includes ECMA-core types, named imports, and same-file declarations", () => {
    const scope = buildScopedTypeNames(
      "import { Foo } from './a';\ninterface Bar {}\ntype Baz = number;\nclass Qux {}\nenum E {}",
      "t.ts",
    );
    expect(scope.has("Date")).toBe(true); // ECMA core
    expect(scope.has("Foo")).toBe(true); // named import
    expect(scope.has("Bar")).toBe(true); // interface
    expect(scope.has("Baz")).toBe(true); // type alias
    expect(scope.has("Qux")).toBe(true); // class
    expect(scope.has("E")).toBe(true); // enum
  });

  it("excludes non-core ambients (DOM) on the text path", () => {
    const scope = buildScopedTypeNames("const x = 1;", "t.ts");
    expect(scope.has("Window")).toBe(false);
    expect(scope.has("HTMLElement")).toBe(false);
  });

  it("adds React for .tsx / .jsx files only", () => {
    expect(buildScopedTypeNames("const x = 1;", "c.tsx").has("React")).toBe(true);
    expect(buildScopedTypeNames("const x = 1;", "c.ts").has("React")).toBe(false);
  });

  it("captures default and namespace imports", () => {
    const scope = buildScopedTypeNames(
      "import Def from './a';\nimport * as NS from './b';",
      "t.ts",
    );
    expect(scope.has("Def")).toBe(true);
    expect(scope.has("NS")).toBe(true);
  });

  // Migrated from apply-types.spec.ts's "requireTypeRefInScope" block.
  it("captures a type-only import", () => {
    const scope = buildScopedTypeNames("import type { AppLogger } from './AppLogger';", "t.ts");
    expect(scope.has("AppLogger")).toBe(true);
  });

  it("excludes a Node-internal name not in the ECMA-core allowlist (Timeout)", () => {
    expect(buildScopedTypeNames("function f(x) {}", "t.ts").has("Timeout")).toBe(false);
  });
});

describe("allTypeRefsInScope", () => {
  it("accepts when every PascalCase ref is in scope", () => {
    expect(allTypeRefsInScope("Foo | Bar", new Set(["Foo", "Bar"]))).toBe(true);
  });

  it("rejects when any ref is unreachable", () => {
    expect(allTypeRefsInScope("Foo | Qux", new Set(["Foo"]))).toBe(false);
  });

  it("accepts everything when no scope set is supplied (feature off)", () => {
    expect(allTypeRefsInScope("Anything", undefined)).toBe(true);
  });

  it("checks only the top-level identifier of a dotted reference", () => {
    expect(allTypeRefsInScope("React.ReactElement", new Set(["React"]))).toBe(true);
  });
});

describe("expandCtorArity", () => {
  it("fills bare generic names with <unknown, …> to their arity", () => {
    expect(
      expandCtorArity(
        "Map | Foo",
        new Map([
          ["Map", 2],
          ["Foo", 1],
        ]),
      ),
    ).toBe("Map<unknown, unknown> | Foo<unknown>");
  });

  it("leaves names with no recorded arity untouched", () => {
    expect(expandCtorArity("string | Bar", new Map([["Map", 2]]))).toBe("string | Bar");
  });

  it("does not double-expand an already-parameterized name", () => {
    expect(expandCtorArity("Map<string, number>", new Map([["Map", 2]]))).toBe(
      "Map<string, number>",
    );
  });

  // Migrated from apply-types.spec.ts's pure-function "expandCtorArity" block.
  it("expands a single-arity name to Name<unknown>", () => {
    expect(expandCtorArity("Container", new Map([["Container", 1]]))).toBe("Container<unknown>");
  });

  it("expands a name embedded in a union, leaving the rest intact", () => {
    expect(expandCtorArity("Container | null", new Map([["Container", 1]]))).toBe(
      "Container<unknown> | null",
    );
  });

  it("does not expand a lowercase primitive even if it appears in the arity map", () => {
    expect(expandCtorArity("string", new Map([["string", 1]]))).toBe("string");
  });
});

describe("TypeChecker path (fixture Program)", () => {
  function buildProgram(
    content: string,
    filename = "test.ts",
  ): { program: ts.Program; abs: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-scope-"));
    const abs = path.join(dir, filename);
    fs.writeFileSync(abs, content);
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
    const config = ts.readConfigFile(path.join(dir, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
    return {
      program: ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }),
      abs,
    };
  }

  it("picks up a DOM ambient the text path would miss", () => {
    const { program, abs } = buildProgram("const x = 1;");
    const scope = buildScopedTypeNamesViaTypeChecker(program, abs);
    expect(scope?.has("HTMLElement")).toBe(true);
  });

  it("returns undefined for a file not in the program", () => {
    const { program } = buildProgram("const x = 1;");
    expect(buildScopedTypeNamesViaTypeChecker(program, "/nope/missing.ts")).toBeUndefined();
  });

  it("records the type-parameter arity of a generic same-file type", () => {
    const { program, abs } = buildProgram("export interface Box<T> { value: T }");
    const arity = buildCtorArityMap(program, abs);
    expect(arity?.get("Box")).toBe(1);
  });

  // Migrated from apply-types.spec.ts's "generic ctor arity expansion" block.
  it("records the arity of a two-parameter generic class", () => {
    const { program, abs } = buildProgram(
      "export class Pair<A, B> { constructor(public a: A, public b: B) {} }",
    );
    expect(buildCtorArityMap(program, abs)?.get("Pair")).toBe(2);
  });

  it("excludes a non-generic class from the arity map", () => {
    const { program, abs } = buildProgram(
      "export class Plain { constructor(public x: number) {} }",
    );
    expect(buildCtorArityMap(program, abs)?.has("Plain")).toBe(false);
  });
});
