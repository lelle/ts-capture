import ts from "typescript";
import { describe, expect, it } from "vitest";

import { narrowParamShape } from "./param-shape-narrowing.js";

/** The first parameter named `p` in `source`, with parents set. */
function paramNamed(source: string, name = "p"): ts.ParameterDeclaration {
  const sf = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
  let found: ts.ParameterDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isParameter(node) && node.name.getText() === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`no parameter ${name} in ${source}`);
  return found;
}

const SHAPE = "{ a: number, b: string, c: boolean }";

describe("narrowParamShape", () => {
  it("keeps only the properties the body reads", () => {
    const p = paramNamed("function f(p) { return p.a + p.b.length; }");
    expect(narrowParamShape(SHAPE, p)).toBe("{ a: number, b: string }");
  });

  it("counts an element access by string literal, and a write, as a read", () => {
    const p = paramNamed('function f(p) { p["a"] = 1; p.c = true; }');
    expect(narrowParamShape(SHAPE, p)).toBe("{ a: number, c: boolean }");
  });

  it("counts the keys of a destructuring declaration as reads", () => {
    const p = paramNamed("function f(p) { const { a, b: label } = p; return label; }");
    expect(narrowParamShape(SHAPE, p)).toBe("{ a: number, b: string }");
  });

  it("narrows a destructured parameter to the keys it binds", () => {
    const sf = ts.createSourceFile(
      "probe.ts",
      "function f({ a, b: label }) { return label; }",
      ts.ScriptTarget.Latest,
      true,
    );
    const fn = sf.statements[0] as ts.FunctionDeclaration;
    expect(narrowParamShape(SHAPE, fn.parameters[0])).toBe("{ a: number, b: string }");
  });

  it("keeps the modifiers of the members it keeps", () => {
    const p = paramNamed("function f(p) { return p.a ?? p.b; }");
    expect(narrowParamShape("{ a?: number, readonly b: string, c: boolean }", p)).toBe(
      "{ a?: number, readonly b: string }",
    );
  });

  it("narrows each object arm of a union and leaves the other arms alone", () => {
    const p = paramNamed("function f(p) { return p ? p.a : 0; }");
    expect(narrowParamShape(`undefined|${SHAPE}`, p)).toBe("undefined|{ a: number }");
  });

  it("reads through a nested function that closes over the parameter", () => {
    const p = paramNamed("function f(p) { return [1].map(() => p.a); }");
    expect(narrowParamShape(SHAPE, p)).toBe("{ a: number }");
  });

  it("ignores reads of properties the shape does not have", () => {
    const p = paramNamed("function f(p) { return p.a + p.toString(); }");
    expect(narrowParamShape(SHAPE, p)).toBe("{ a: number }");
  });

  // A check that the value is there says nothing about its shape.
  it("does not count a truthiness or nullish check as the parameter escaping", () => {
    const p = paramNamed(
      "function f(p) { if (!p || p === null || p == undefined) return 0; return p?.a; }",
    );
    expect(narrowParamShape(SHAPE, p)).toBe("{ a: number }");
  });

  describe("keeps the whole shape when the parameter escapes", () => {
    const cases: Array<[string, string]> = [
      ["passed to a call", "function f(p) { g(p); return p.a; }"],
      ["returned", "function f(p) { p.a; return p; }"],
      ["assigned", "function f(p) { const q = p; return p.a; }"],
      ["put in an object", "function f(p) { return { p, a: p.a }; }"],
      ["spread", "function f(p) { return { ...p, a: p.a }; }"],
      ["iterated with `in`", "function f(p) { for (const k in p) k; return p.a; }"],
      ["tested with `in`", 'function f(p) { return "a" in p && p.a; }'],
      ["indexed by a variable", "function f(p, k) { return p[k] + p.a; }"],
      ["destructured with a rest", "function f(p) { const { a, ...rest } = p; return rest; }"],
      ["chosen by `||`", "function f(p) { return (p || {}).a; }"],
      ["queried as a type", "function f(p) { type T = typeof p; return p.a; }"],
      ["reachable through `arguments`", "function f(p) { arguments[0]; return p.a; }"],
      ["shadowed inside the body", "function f(p) { const g = (p) => p.b; return p.a + g(p); }"],
    ];
    for (const [how, source] of cases) {
      it(how, () => {
        expect(narrowParamShape(SHAPE, paramNamed(source))).toBe(SHAPE);
      });
    }
  });

  it("keeps the whole shape when the body reads nothing from the parameter", () => {
    expect(narrowParamShape(SHAPE, paramNamed("function f(p) { return 1; }"))).toBe(SHAPE);
  });

  it("keeps the whole shape when no member is read", () => {
    const p = paramNamed("function f(p) { return p.toString(); }");
    expect(narrowParamShape(SHAPE, p)).toBe(SHAPE);
  });

  it("leaves a shape that is not at the top level alone", () => {
    const p = paramNamed("function f(p) { return p.length; }");
    expect(narrowParamShape(`${SHAPE}[]`, p)).toBe(`${SHAPE}[]`);
  });

  it("leaves a type that is not an object literal alone", () => {
    expect(narrowParamShape("Product", paramNamed("function f(p) { return p.a; }"))).toBe(
      "Product",
    );
  });

  it("leaves a shape with a member it cannot name alone", () => {
    const p = paramNamed("function f(p) { return p.a; }");
    expect(narrowParamShape("{ a: number, [key: string]: unknown }", p)).toBe(
      "{ a: number, [key: string]: unknown }",
    );
  });

  it("leaves the shape alone when the function has no body", () => {
    const p = paramNamed("declare function f(p);");
    expect(narrowParamShape(SHAPE, p)).toBe(SHAPE);
  });
});
