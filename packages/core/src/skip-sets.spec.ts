import { describe, expect, it } from "vitest";

import {
  buildOuterAnnotationSkipSet,
  detectParenLessArrowParam,
  isAlreadyApplied,
  positionLooksLikeInsertionSite,
} from "./skip-sets.js";

// Direct specs for the offset-applier's position guards + skip-set builder. Previously
// reachable only through a full applyTypesToFile round-trip.

describe("positionLooksLikeInsertionSite", () => {
  it("accepts a position at the end of an identifier binding", () => {
    const src = "function f(a) {}";
    const pos = src.indexOf("a)") + 1; // after `a`, before `)`
    expect(positionLooksLikeInsertionSite(src, pos, {})).toBe(true);
  });

  it("rejects a position in the middle of an identifier", () => {
    const src = "const value = 1;";
    expect(positionLooksLikeInsertionSite(src, src.indexOf("lue"), {})).toBe(false);
  });

  it("requires `(` before a thisType insertion", () => {
    const src = "function f(a) {}";
    const afterParen = src.indexOf("(") + 1;
    expect(positionLooksLikeInsertionSite(src, afterParen, { thisType: true })).toBe(true);
    expect(positionLooksLikeInsertionSite(src, afterParen + 1, { thisType: true })).toBe(false);
  });

  it("accepts a returnType position right after `)`", () => {
    const src = "function f() {}";
    expect(positionLooksLikeInsertionSite(src, src.indexOf(")") + 1, { returnType: true })).toBe(
      true,
    );
  });
});

describe("isAlreadyApplied", () => {
  it("reports a param that already carries a type annotation", () => {
    const src = "function f(a: number) {}";
    const pos = src.indexOf("a:") + 1; // a.name.end
    expect(isAlreadyApplied(src, pos, {})).toBe(true);
  });

  it("reports an untyped param as not-applied", () => {
    const src = "function f(a) {}";
    expect(isAlreadyApplied(src, src.indexOf("a)") + 1, {})).toBe(false);
  });
});

describe("detectParenLessArrowParam", () => {
  it("detects a paren-less single-param arrow", () => {
    const src = "const f = x => x;";
    expect(detectParenLessArrowParam(src, src.indexOf("x =>") + 1)).toBeDefined();
  });

  it("returns undefined for a paren-wrapped arrow", () => {
    const src = "const f = (x) => x;";
    expect(detectParenLessArrowParam(src, src.indexOf("x)") + 1)).toBeUndefined();
  });
});

describe("buildOuterAnnotationSkipSet", () => {
  it("skips the outer var-decl annotation when the RHS is a function expression", () => {
    const src = "const f = () => 1;";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("f ") + 1)).toBe(true);
  });

  it("does NOT skip a var-decl with a non-function RHS", () => {
    const src = "const x = 42;";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("x ") + 1)).toBe(false);
  });

  // Migrated from apply-types.spec.ts's "outer-annotation skip on typed-RHS var
  // declarations" block. The guard fires on the RHS being a function (arrow OR
  // `function` expression, typed or untyped), across plain var-decls and
  // class-field PropertyDeclarations; it never fires on a non-function RHS.
  it("skips when the RHS is a `function` expression", () => {
    const src = "const fn = function (n: number): number { return n; };";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("fn") + 2)).toBe(true);
  });

  it("skips even when the arrow RHS is fully untyped (guard is RHS-is-function, not RHS-is-typed)", () => {
    const src = "const noTypes = (a, b) => a + b;";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("noTypes") + "noTypes".length)).toBe(true);
  });

  it("skips a class-field arrow (PropertyDeclaration)", () => {
    const src = "class C {\n  setLayout = (l: string) => l + '!';\n}";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("setLayout") + "setLayout".length)).toBe(true);
  });

  it("skips a class-field `function` expression (PropertyDeclaration)", () => {
    const src = "class C {\n  fn = function (n: number): number { return n; };\n}";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("fn") + 2)).toBe(true);
  });

  it("does NOT skip a class-field with a non-function RHS", () => {
    const src = "class C {\n  count = 42;\n}";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("count") + "count".length)).toBe(false);
  });

  // Migrated from apply-types.spec.ts's "skip varDecl annotation inside
  // generic-function body" and "skip varDecl annotation when call has explicit
  // typeArguments" blocks. The offset path collapses all outer-annotation
  // conflicts into this one `skip` set: a var-decl inside a generic enclosing
  // function (annotating would burn the type parameter to a concrete sample),
  // and a call initializer with explicit type arguments (already typed).
  it("skips a var-decl inside a generic enclosing function", () => {
    const src = "function pick<T extends object>(o: T, k: keyof T) {\n  const v = o[k];\n}";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("const v = ") + "const v".length)).toBe(true);
  });

  it("does NOT skip a var-decl inside a non-generic function", () => {
    const src = "function pick(o: object) {\n  const v = o;\n}";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has(src.indexOf("const v = ") + "const v".length)).toBe(false);
  });

  it("skips a var-decl whose initializer call has explicit type arguments", () => {
    const src = "const data = parseModelResponse<MyType>(json);";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has("const data".length)).toBe(true);
  });

  it("does NOT skip a var-decl whose initializer call has no type arguments", () => {
    const src = "const data = parseModelResponse(json);";
    const sets = buildOuterAnnotationSkipSet(src);
    expect(sets.skip.has("const data".length)).toBe(false);
  });
});

describe("buildOuterAnnotationSkipSet — unionProducingInitializer", () => {
  // Migrated from apply-types.spec.ts's "skip undefined-narrowing on
  // union-producing initializer" and "extension: more union-producing AST
  // shapes" blocks. A union-producing initializer (??, ternary, ||, &&, ?., and
  // the always-`T | undefined` Array#find / #findLast, optionally chained) is
  // flagged so a single-observation annotation does not burn one branch's type
  // onto the union site. Plain literals and non-union calls (.map) are not.
  const upHas = (src: string, pos: number) =>
    buildOuterAnnotationSkipSet(src).unionProducingInitializer.has(pos);

  it("flags a `?? undefined` nullish coalesce", () => {
    expect(upHas("const v = maybe() ?? undefined;", 7)).toBe(true);
  });

  it("flags a ternary with an undefined branch", () => {
    expect(upHas("const v = flag ? compute() : undefined;", 7)).toBe(true);
  });

  it("flags a `|| undefined` logical-or", () => {
    expect(upHas("const v = pick() || undefined;", 7)).toBe(true);
  });

  it("flags an `a && b()` short-circuit", () => {
    expect(upHas("let v = flag && compute();", 5)).toBe(true);
  });

  it("flags an optional-chain `obj?.prop`", () => {
    expect(upHas("let v = obj?.prop;", 5)).toBe(true);
  });

  it("flags an optional-call `arr?.find(...)`", () => {
    expect(upHas("let v = arr?.find(x => x.id === id);", 5)).toBe(true);
  });

  it("flags `Array#find` (always returns T | undefined)", () => {
    expect(upHas("let v = arr.find(x => x.id === id);", 5)).toBe(true);
  });

  it("flags `Array#findLast`", () => {
    expect(upHas("let v = arr.findLast(x => x.id === id);", 5)).toBe(true);
  });

  it("does NOT flag a non-union call like `arr.map(...)`", () => {
    expect(upHas("let v = arr.map(x => x.id);", 5)).toBe(false);
  });

  it("does NOT flag a plain `= undefined` literal initializer", () => {
    expect(upHas("let v = undefined;", 5)).toBe(false);
  });
});

describe("buildOuterAnnotationSkipSet — opaqueInitializerVarDecls", () => {
  // Migrated from apply-types.spec.ts's "skip sole-undefined on opaque
  // initializers" block. An opaque initializer (await, call, method call, new)
  // is flagged so a sole-undefined observation does not narrow a `T | undefined`
  // contract to `: undefined`. The literal `undefined` / `void 0` keyword forms
  // are NOT flagged — there `: undefined` is the user's intent.
  const opHas = (src: string, pos: number) =>
    buildOuterAnnotationSkipSet(src).opaqueInitializerVarDecls.has(pos);

  it("flags an `await call()` initializer", () => {
    const src = "async function f() {\n  let v = await getThing();\n  return v;\n}";
    expect(opHas(src, src.indexOf("let v") + "let v".length)).toBe(true);
  });

  it("flags a plain `call()` initializer", () => {
    expect(opHas("const v = getString(key);", 7)).toBe(true);
  });

  it("flags an `obj.method(arg)` initializer", () => {
    expect(opHas("const v = service.fetch(id);", 7)).toBe(true);
  });

  it("flags a `new Foo()` initializer", () => {
    expect(opHas("const v = new Foo();", 7)).toBe(true);
  });

  it("does NOT flag a literal `= undefined`", () => {
    expect(opHas("let v = undefined;", 5)).toBe(false);
  });

  it("does NOT flag an explicit `= void 0`", () => {
    expect(opHas("let v = void 0;", 5)).toBe(false);
  });
});

describe("buildOuterAnnotationSkipSet — arrayCallbackArrowParams", () => {
  // Migrated from apply-types.spec.ts's "skip arrow-param annotation in
  // Array.prototype callbacks" block. Arrow params (and the callback's
  // returnType position) inside a well-known contextually-typed Array.prototype
  // method call are flagged; the suppression decision itself lives in
  // annotation-eligibility.spec.ts (suppressArrayCallbackStructural). A free
  // arrow and a bare-name `filter(...)` with no array receiver are not flagged.
  const has = (src: string, pos: number) =>
    buildOuterAnnotationSkipSet(src).arrayCallbackArrowParams.has(pos);

  it("flags the arrow param of `.filter(...)`", () => {
    const src = "const r = arr.filter(product => product.active);";
    expect(has(src, src.indexOf("product") + "product".length)).toBe(true);
  });

  it("flags the arrow param of `.map(...)`", () => {
    const src = "const r = arr.map(x => x.id);";
    expect(has(src, src.indexOf("x ") + 1)).toBe(true);
  });

  it("flags the arrow param of `.some(...)`", () => {
    const src = "const r = arr.some(x => x.flag);";
    expect(has(src, src.indexOf("x ") + 1)).toBe(true);
  });

  it("flags the arrow param of `.find(...)`", () => {
    const src = "const r = arr.find(x => x.id === id);";
    expect(has(src, src.indexOf("x ") + 1)).toBe(true);
  });

  it("flags the arrow param of `.forEach(...)`", () => {
    const src = "arr.forEach(x => doStuff(x));";
    expect(has(src, src.indexOf("x ") + 1)).toBe(true);
  });

  it("flags both arrow params of `.reduce((acc, x) => ...)`", () => {
    const src = "const r = arr.reduce((acc, x) => acc + x.n, 0);";
    expect(has(src, src.indexOf("acc,") + 3)).toBe(true);
    expect(has(src, src.indexOf("x)") + 1)).toBe(true);
  });

  it("flags the returnType position of a paren-less callback arrow", () => {
    const src = "const r = arr.map(p => p.price);";
    expect(has(src, src.indexOf("p ") + 1)).toBe(true);
  });

  it("flags the returnType position of a paren-wrapped callback arrow", () => {
    const src = "const r = arr.filter((p) => p.flag);";
    expect(has(src, src.indexOf(") =>") + 1)).toBe(true);
  });

  it("does NOT flag a free arrow not inside an array callback", () => {
    const src = "const fn = (x) => x.id;";
    expect(has(src, src.indexOf("(x)") + 2)).toBe(false);
  });

  it("does NOT flag a bare-name `filter(...)` with no array receiver", () => {
    const src = "const r = filter(product => product.active);";
    expect(has(src, src.indexOf("product") + "product".length)).toBe(false);
  });
});
