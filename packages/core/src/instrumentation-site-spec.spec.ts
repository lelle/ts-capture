import ts from "typescript";
import { describe, expect, it } from "vitest";

import { findInstrumentationSite } from "./instrumentation-site-spec.js";

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
}

function firstFn(sf: ts.SourceFile): ts.FunctionDeclaration {
  return sf.statements[0] as ts.FunctionDeclaration;
}

describe("findInstrumentationSite — param", () => {
  it("lands the probe just after the parameter name", () => {
    const src = "function foo(a) { return a; }";
    const sf = parse(src);
    const fn = firstFn(sf);
    const site = findInstrumentationSite(fn.parameters[0], "param", sf, { fn })!;
    expect(site.kind).toBe("param");
    expect(src[site.pos - 1]).toBe("a");
    expect(site.opts).toEqual({});
  });

  it("accounts for the optional `?` token in the offset", () => {
    const src = "function foo(a?) { return a; }";
    const sf = parse(src);
    const fn = firstFn(sf);
    const site = findInstrumentationSite(fn.parameters[0], "param", sf, { fn })!;
    expect(src[site.pos - 1]).toBe("?");
  });

  it("carries fnRetPos when supplied", () => {
    const src = "function foo(a) { return a; }";
    const sf = parse(src);
    const fn = firstFn(sf);
    const site = findInstrumentationSite(fn.parameters[0], "param", sf, { fn, fnRetPos: 15 })!;
    expect(site.opts).toEqual({ fnRetPos: 15 });
  });

  it("marks arrow + parens for a paren-less single-param arrow", () => {
    const src = "const f = x => x + 1;";
    const sf = parse(src);
    const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    const arrow = decl.initializer as ts.ArrowFunction;
    const site = findInstrumentationSite(arrow.parameters[0], "param", sf, { fn: arrow })!;
    expect(site.opts.arrow).toBe(true);
    expect(site.opts.parens).toEqual([
      arrow.parameters[0].getStart(sf),
      arrow.parameters[0].getEnd(),
    ]);
  });
});

describe("findInstrumentationSite — return", () => {
  it("lands the probe just after the closing paren", () => {
    const src = "function foo(a) { return a; }";
    const sf = parse(src);
    const site = findInstrumentationSite(firstFn(sf), "return", sf)!;
    expect(site.kind).toBe("return");
    expect(src[site.pos - 1]).toBe(")");
    expect(site.opts).toEqual({ returnType: true });
  });

  it("marks async functions", () => {
    const src = "async function foo() { return 1; }";
    const sf = parse(src);
    const site = findInstrumentationSite(firstFn(sf), "return", sf)!;
    expect(site.opts).toEqual({ returnType: true, async: true });
  });

  it("returns null for a function with an explicit return type", () => {
    const sf = parse("function foo(a): number { return 1; }");
    expect(findInstrumentationSite(firstFn(sf), "return", sf)).toBeNull();
  });

  it("returns null for a constructor and a generator", () => {
    const ctorSf = parse("class C { constructor(a) {} }");
    const ctor = (ctorSf.statements[0] as ts.ClassDeclaration)
      .members[0] as ts.ConstructorDeclaration;
    expect(findInstrumentationSite(ctor, "return", ctorSf)).toBeNull();

    const genSf = parse("function* g() { yield 1; }");
    expect(findInstrumentationSite(firstFn(genSf), "return", genSf)).toBeNull();
  });
});

describe("findInstrumentationSite — varDecl", () => {
  it("lands the probe just after the variable name", () => {
    const src = "const x = foo();";
    const sf = parse(src);
    const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    const site = findInstrumentationSite(decl, "varDecl", sf)!;
    expect(src[site.pos - 1]).toBe("x");
    expect(site.opts).toEqual({ varDecl: true });
  });

  it("marks an `as` cast with hasAsCast", () => {
    const sf = parse("const x = foo() as Bar;");
    const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    const site = findInstrumentationSite(decl, "varDecl", sf)!;
    expect(site.opts).toEqual({ varDecl: true, hasAsCast: true });
  });

  it("does NOT mark `as const`", () => {
    const sf = parse("const x = foo() as const;");
    const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    const site = findInstrumentationSite(decl, "varDecl", sf)!;
    expect(site.opts).toEqual({ varDecl: true });
  });
});

describe("findInstrumentationSite — propertyDecl", () => {
  it("lands the probe just after the property name with varDecl opts", () => {
    const src = "class C { x = 1; }";
    const sf = parse(src);
    const prop = (sf.statements[0] as ts.ClassDeclaration).members[0] as ts.PropertyDeclaration;
    const site = findInstrumentationSite(prop, "propertyDecl", sf)!;
    expect(src[site.pos - 1]).toBe("x");
    expect(site.opts).toEqual({ varDecl: true });
  });
});

describe("findInstrumentationSite — implicitThis", () => {
  it("probes at the parameter-list position with thisType opts", () => {
    const sf = parse("function foo() { return this; }");
    const site = findInstrumentationSite(firstFn(sf), "implicitThis", sf)!;
    expect(site.pos).toBe(firstFn(sf).parameters.pos);
    expect(site.opts).toEqual({ thisType: true });
  });

  it("flags thisNeedsComma when the function already has params", () => {
    const sf = parse("function foo(a) { return this; }");
    const site = findInstrumentationSite(firstFn(sf), "implicitThis", sf)!;
    expect(site.opts).toEqual({ thisType: true, thisNeedsComma: true });
  });
});

describe("findInstrumentationSite — paramReturn", () => {
  it("assembles opts from the matched callback-param context", () => {
    const sf = parse("const c = cb(1);");
    const call = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0]
      .initializer as ts.CallExpression;
    const site = findInstrumentationSite(call, "paramReturn", sf, {
      paramReturnPos: 42,
      paramReturnMember: "cb",
    })!;
    expect(site.pos).toBe(42);
    expect(site.opts).toEqual({ paramReturn: true, paramReturnMember: "cb" });
  });
});
