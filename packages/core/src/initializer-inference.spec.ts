import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  buildInferableInfoMap,
  hasConstAssertion,
  inferTypeFromInitializer,
} from "./initializer-inference.js";

// Boundary spec for the syntactic initializer-inference behind
// skipRedundantAnnotations. inferTypeFromInitializer computes the type TS would
// infer from a var-decl / class-field initializer using syntax only (no type
// checker); buildInferableInfoMap locates those initializers and records the
// binding's literal-narrowing behaviour. The applier suppresses its own
// annotation when this inferred type equals the emitted one. Migrated from the
// "skipRedundantAnnotations" block of the 4,604-line apply-types.spec.ts.

// Each fixture has exactly one inferable binding; infer its syntactic type.
function infer(source: string): string | null {
  const info = [...buildInferableInfoMap(source).values()][0];
  if (!info) throw new Error("no inferable binding in fixture");
  return inferTypeFromInitializer(info.initializer, info.narrowsLiterals);
}

describe("inferTypeFromInitializer — symbols", () => {
  // `const S = Symbol('x')` gives TypeScript a `unique symbol`. Annotating it
  // `: symbol` widens that away, and every `x === S` narrowing downstream
  // stops working. On nestjs/nest a single such annotation on
  // `VERSION_NEUTRAL` produced three compile errors in unrelated files.
  it("infers symbol from Symbol(...)", () => {
    expect(infer("const s = Symbol('x');")).toBe("symbol");
  });

  it("infers symbol from Symbol.for(...)", () => {
    expect(infer("const s = Symbol.for('x');")).toBe("symbol");
  });

  it("does not treat an unrelated call named like a member as Symbol", () => {
    expect(infer("const s = ns.Symbol('x');")).toBe(null);
  });
});

describe("inferTypeFromInitializer — primitives", () => {
  it("infers number from a numeric literal", () => {
    expect(infer("let x = 5;")).toBe("number");
  });

  it("infers string from single- and double-quoted strings", () => {
    expect(infer("const FORM_ERROR_TYPE = 'form';")).toBe("string");
    expect(infer('let s = "hello";')).toBe("string");
  });

  it("infers string from a template with substitutions", () => {
    expect(infer("const greeting = `hi ${name}`;")).toBe("string");
  });

  it("widens a const numeric literal to number (not the literal type)", () => {
    expect(infer("const x = 5;")).toBe("number");
  });

  it("unwraps parentheses before inferring", () => {
    expect(infer("let x = (5);")).toBe("number");
  });
});

describe("inferTypeFromInitializer — as const", () => {
  it("infers number from `5 as const` (a primitive still returns the widened type)", () => {
    expect(infer("let y = 5 as const;")).toBe("number");
  });

  it("infers the widened object shape from `{ a: 1 } as const`", () => {
    expect(infer("const X = { a: 1 } as const;")).toBe("{ a: number }");
  });
});

describe("inferTypeFromInitializer — arrays", () => {
  it("infers T[] from a homogeneous primitive array (let and const widen alike)", () => {
    expect(infer("let arr = [1, 2, 3];")).toBe("number[]");
    expect(infer("const arr = [1, 2, 3];")).toBe("number[]");
  });

  it("returns null for an empty array (TS would infer never[])", () => {
    expect(infer("const arr = [];")).toBeNull();
  });

  it("returns null for a heterogeneous array (unions are not modelled here)", () => {
    expect(infer('const arr = [1, "two"];')).toBeNull();
  });
});

describe("inferTypeFromInitializer — objects", () => {
  it("infers a sorted-key object shape from an object literal", () => {
    expect(infer('const obj = { a: 1, b: "hi" };')).toBe("{ a: number, b: string }");
  });
});

describe("inferTypeFromInitializer — new expressions & opaque", () => {
  it("infers the constructor name from `new Identifier()`", () => {
    expect(infer("const cat = new Cat();")).toBe("Cat");
  });

  it("returns null for a qualified constructor `new ns.Cls()`", () => {
    expect(infer("const cat = new ns.Cat();")).toBeNull();
  });

  it("returns null for a function-call initializer (no syntactic inference)", () => {
    expect(infer("const x = JSON.parse(s);")).toBeNull();
  });
});

describe("buildInferableInfoMap", () => {
  it("keys the map by the binding name's end position", () => {
    const map = buildInferableInfoMap("let x = 5;");
    expect(map.has(5)).toBe(true); // `x` ends at offset 5
  });

  it("records literal narrowing: const narrows, let does not", () => {
    expect([...buildInferableInfoMap("const x = 5;").values()][0].narrowsLiterals).toBe(true);
    expect([...buildInferableInfoMap("let x = 5;").values()][0].narrowsLiterals).toBe(false);
  });

  it("records literal narrowing for class fields: readonly narrows, plain does not", () => {
    expect(
      [...buildInferableInfoMap("class C { readonly x = 5; }").values()][0].narrowsLiterals,
    ).toBe(true);
    expect([...buildInferableInfoMap("class C { x = 5; }").values()][0].narrowsLiterals).toBe(
      false,
    );
  });

  it("does not record a binding with no initializer", () => {
    expect(buildInferableInfoMap("let x;").size).toBe(0);
  });
});

describe("hasConstAssertion", () => {
  const has = (source: string): boolean => {
    const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found: boolean | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        found = hasConstAssertion(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (found === undefined) throw new Error("no initialised declaration in fixture");
    return found;
  };

  it.each([
    "const x = { a: 1 } as const;",
    "const x = [1, 2] as const;",
    "const x = ({ a: 1 } as const);",
    "const x = [1, 2] as const satisfies number[];",
    "const x = { a: 1 } as const satisfies Record<string, number>;",
  ])("%s carries a const assertion", (source) => {
    expect(has(source)).toBe(true);
  });

  it.each([
    "const x = { a: 1 };",
    "const x = [1, 2];",
    "const x = y as Foo;",
    "const x = { a: 1 } satisfies Record<string, number>;",
    "const x = { a: 1 as const };",
  ])("%s does not", (source) => {
    expect(has(source)).toBe(false);
  });
});
