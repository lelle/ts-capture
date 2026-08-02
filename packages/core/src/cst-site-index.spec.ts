import ts from "typescript";
import { describe, expect, it } from "vitest";

import { INFER_DEFAULTS } from "./configuration.js";
import { buildCstSiteIndex, type CstSiteIndex } from "./cst-site-index.js";

// Direct specs for the visit-indexer. Before
// the extraction these offset computations were only reachable through a full
// applyTypesToFileCst round-trip; now the index can be asserted per construct.

function index(src: string, infer = INFER_DEFAULTS): CstSiteIndex {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return buildCstSiteIndex(sf, src, infer);
}

describe("buildCstSiteIndex", () => {
  describe("param sites", () => {
    it("indexes an identifier param at name.end", () => {
      const src = "function f(a) {}";
      const idx = index(src);
      // pos for `a` is name.end = index('a') + 1.
      const pos = src.indexOf("(a") + 2;
      expect(idx.paramSites.has(pos)).toBe(true);
      expect(idx.paramSites.get(pos)!.parensOpenPos).toBeUndefined();
    });

    it("shifts an optional param's pos by 1 past the question token", () => {
      // Untyped optional param — a typed one (`a?: number`) would be skipped
      // as already-typed, so the questionToken offset must be probed bare.
      const src = "function f(a?) {}";
      const idx = index(src);
      const nameEnd = src.indexOf("a?") + 1;
      // The site lands at name.end + 1 (past `?`), not name.end.
      expect(idx.paramSites.has(nameEnd + 1)).toBe(true);
      expect(idx.paramSites.has(nameEnd)).toBe(false);
    });

    it("indexes a binding-pattern (destructure) param at pattern.end", () => {
      const src = "function f({ a, b }) {}";
      const idx = index(src);
      // name.end is the position just after the closing `}`.
      const pos = src.indexOf("}", src.indexOf("{")) + 1;
      expect(idx.paramSites.has(pos)).toBe(true);
    });

    it("records parensOpenPos for a paren-less single-param arrow", () => {
      const src = "const f = x => x;";
      const idx = index(src);
      const pos = src.indexOf("x =>") + 1; // name.end of `x`
      const site = idx.paramSites.get(pos);
      expect(site).toBeDefined();
      expect(site!.parensOpenPos).toBe(src.indexOf("x =>"));
    });

    it("skips already-typed params unless ignoreExistingTypes", () => {
      const src = "function f(a: number) {}";
      expect(index(src).paramSites.size).toBe(0);
      const withIgnore = index(src, { ...INFER_DEFAULTS, ignoreExistingTypes: true });
      expect(withIgnore.paramSites.size).toBe(1);
    });
  });

  describe("return-type + this sites", () => {
    it("indexes a return-type site for a function with no return type", () => {
      const src = "function f() {}";
      const idx = index(src);
      const closeParen = src.indexOf(")") + 1;
      expect(idx.returnTypeSites.get(closeParen)).toEqual({ hasReturnType: false });
    });

    it("flags hasReturnType when one is already present", () => {
      const src = "function f(): void {}";
      const idx = index(src);
      const closeParen = src.indexOf(")") + 1;
      expect(idx.returnTypeSites.get(closeParen)).toEqual({ hasReturnType: true });
    });

    it("does not index a return-type site for a generator", () => {
      const idx = index("function* g() {}");
      expect(idx.returnTypeSites.size).toBe(0);
    });

    it("indexes a this-site at parameters.pos with hasOtherParams", () => {
      const src = "function f(a) {}";
      const idx = index(src);
      const paramsPos = src.indexOf("(") + 1;
      expect(idx.thisTypeSites.get(paramsPos)).toEqual({ hasOtherParams: true });
      expect(index("function g() {}").thisTypeSites.get(src.indexOf("(") + 1)).toEqual({
        hasOtherParams: false,
      });
    });
  });

  describe("var-decl sites and guard flags", () => {
    it("flags rhsIsFunction for a function-expression initializer", () => {
      const src = "const f = () => 1;";
      const site = index(src).varDeclSites.get(src.indexOf("f") + 1)!;
      expect(site.rhsIsFunction).toBe(true);
    });

    it("flags hasInitializerTypeArguments for a generic call", () => {
      const src = "const x = make<number>();";
      const site = index(src).varDeclSites.get(src.indexOf("x") + 1)!;
      expect(site.hasInitializerTypeArguments).toBe(true);
    });

    it("flags isUnionProducingInitializer for a ?? initializer", () => {
      const src = "const x = a ?? b;";
      const site = index(src).varDeclSites.get(src.indexOf("x") + 1)!;
      expect(site.isUnionProducingInitializer).toBe(true);
    });

    it("flags narrowsLiterals for const but not let", () => {
      expect(index("const x = 1;").varDeclSites.get(7)!.narrowsLiterals).toBe(true);
      expect(index("let x = 1;").varDeclSites.get(5)!.narrowsLiterals).toBe(false);
    });

    it("flags inGenericContext inside a generic function", () => {
      const src = "function wrap<T>(v: T) { const x = v; return x; }";
      const site = index(src).varDeclSites.get(src.indexOf("const x") + "const x".length)!;
      expect(site.inGenericContext).toBe(true);
    });
  });

  describe("array-callback params and ignored ranges", () => {
    it("indexes Array.prototype callback params", () => {
      const src = "arr.map(x => x);";
      const idx = index(src);
      expect(idx.arrayCallbackArrowParams.has(src.indexOf("x =>") + 1)).toBe(true);
    });

    it("collects a @ts-capture-ignore range", () => {
      const src = "// @ts-capture-ignore\nfunction f(a) {}";
      const idx = index(src);
      expect(idx.ignoredRanges.length).toBe(1);
      const [start, end] = idx.ignoredRanges[0];
      expect(start).toBeLessThan(src.indexOf("function"));
      expect(end).toBe(src.length);
    });
  });
});
