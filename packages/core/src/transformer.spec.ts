import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { InstrumentOptions } from "./transformer.js";

import { transformSourceFile } from "./transformer.js";

function transform(source: string, options: InstrumentOptions = {}): string {
  const sourceFile = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const transformed = transformSourceFile(sourceFile, options);
  return ts.createPrinter().printFile(transformed);
}

describe("transformer", () => {
  describe("__tscptr__ declarations", () => {
    it("adds __tscptr__ declarations to the source file", () => {
      const result = transform("const x = 1;");
      expect(result).toContain("declare function __tscptr__");
      expect(result).toContain("function track");
    });

    it("skips declarations when skipTscptrDeclarations is true", () => {
      const result = transform("const x = 1;", { skipTscptrDeclarations: true });
      expect(result).not.toContain("declare function __tscptr__");
    });
  });

  describe("function parameters", () => {
    it("instruments unannotated parameter", () => {
      const result = transform("function foo(a) { return a; }", { skipTscptrDeclarations: true });
      expect(result).toContain('__tscptr__("a", a,');
      expect(result).toContain('"test.ts"');
    });

    it("instruments multiple unannotated parameters", () => {
      const result = transform("function foo(a, b) { return a + b; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('__tscptr__("a", a,');
      expect(result).toContain('__tscptr__("b", b,');
    });

    it("skips parameters that already have a type", () => {
      const result = transform("function foo(a: string) { return a; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).not.toContain('__tscptr__("a"');
    });

    it("skips parameters with default values", () => {
      const result = transform("function foo(a = 12) { return a; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).not.toContain('__tscptr__("a"');
    });

    it("instruments only unannotated params in mixed declarations", () => {
      const result = transform("function foo(a: string, b) { return a + b; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).not.toContain('"a"');
      expect(result).toContain('__tscptr__("b", b,');
    });

    it("does not instrument function without body", () => {
      const result = transform("declare function foo(a: number): void;", {
        skipTscptrDeclarations: true,
      });
      expect(result).not.toContain("__tscptr__");
    });

    it("handles optional parameters", () => {
      const result = transform("function foo(a?) { return a; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain("__tscptr__");
    });

    it("handles destructured parameters", () => {
      const result = transform("function foo({ a, b }) { return a; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain("__tscptr__");
      // Should contain the destructured name pattern
      expect(result).toMatch(/__tscptr__\("\{ a, b \}"/);
    });

    it("handles rest parameters", () => {
      const result = transform("function foo(...args) { return args; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('__tscptr__("args", args,');
    });
  });

  describe("method parameters", () => {
    it("instruments class method parameters", () => {
      const result = transform("class Foo { bar(a) { return a; } }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('__tscptr__("a", a,');
    });

    it("instruments constructor parameters", () => {
      const result = transform("class Foo { constructor(a) { this.a = a; } }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('__tscptr__("a", a,');
    });
  });

  describe("arrow functions", () => {
    it("instruments arrow function with block body", () => {
      const result = transform("const fn = (x) => { return x; };", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('__tscptr__("x", x,');
      // Should have arrow: true in opts
      expect(result).toContain('\\"arrow\\":true');
    });

    it("instruments arrow function with expression body", () => {
      const result = transform("const fn = (x) => x + 1;", { skipTscptrDeclarations: true });
      expect(result).toContain('__tscptr__("x", x,');
    });

    it("handles arrow function without parens (single param)", () => {
      const result = transform("const fn = x => x + 1;", { skipTscptrDeclarations: true });
      expect(result).toContain('__tscptr__("x", x,');
      // Should include parens info for apply-types to add parentheses
      expect(result).toContain('\\"parens\\"');
    });

    it("handles async arrow function without parens", () => {
      const result = transform("const fn = async x => x + 1;", { skipTscptrDeclarations: true });
      expect(result).toContain('__tscptr__("x", x,');
      expect(result).toContain('\\"parens\\"');
    });

    it("instruments nested arrow functions", () => {
      const result = transform("const fn = (x) => (y) => x + y;", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('__tscptr__("x", x,');
      expect(result).toContain('__tscptr__("y", y,');
    });

    // Paren-less arrow callback nested inside a call expression (the
    // `forEach(x => ...)` pattern). A non-defensive
    // `hasParensAroundArguments` crashes here with "Cannot read property
    // 'text' of undefined" when the arg lookup walks off the end of the
    // call's children. ts-capture's transformer must instrument this
    // without crashing AND emit the parens info so apply-types can wrap
    // `x` correctly.
    it("instruments paren-less arrow callback inside a call expression", () => {
      const result = transform("[1,2,3].forEach(x => console.log(x));", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('__tscptr__("x", x,');
      expect(result).toContain('\\"parens\\"');
    });

    // Stress test: deeply nested paren-less arrows inside calls, mixed
    // with method-chain access. If ts-capture's parens detection walks
    // AST children non-defensively, this is where it'd crash.
    it("does not crash on deeply nested paren-less arrows in method chains", () => {
      expect(() => {
        transform("[1,2,3].map(x => x + 1).filter(y => y > 0).reduce((acc, n) => acc + n, 0);", {
          skipTscptrDeclarations: true,
        });
      }).not.toThrow();
    });
  });

  describe("instrumentCallExpressions", () => {
    it("wraps non-literal call arguments with __tscptr__.track", () => {
      const result = transform("foo(bar)", {
        skipTscptrDeclarations: true,
        instrumentCallExpressions: true,
      });
      expect(result).toContain("__tscptr__.track(bar,");
    });

    it("does not wrap string literal arguments", () => {
      const result = transform('foo("bar")', {
        skipTscptrDeclarations: true,
        instrumentCallExpressions: true,
      });
      expect(result).not.toContain("__tscptr__.track");
    });

    it("does not wrap numeric literal arguments", () => {
      const result = transform("foo(42)", {
        skipTscptrDeclarations: true,
        instrumentCallExpressions: true,
      });
      expect(result).not.toContain("__tscptr__.track");
    });

    it("does not wrap spread arguments", () => {
      const result = transform("foo(...args)", {
        skipTscptrDeclarations: true,
        instrumentCallExpressions: true,
      });
      expect(result).not.toContain("__tscptr__.track");
    });

    it("does not wrap require.context calls", () => {
      const result = transform("require.context('./dir')", {
        skipTscptrDeclarations: true,
        instrumentCallExpressions: true,
      });
      expect(result).not.toContain("__tscptr__.track");
    });

    it("is disabled by default", () => {
      const result = transform("foo(bar)", { skipTscptrDeclarations: true });
      expect(result).not.toContain("__tscptr__.track");
    });
  });

  describe("return type instrumentation", () => {
    it("wraps return expression with __tscptr__.ret", () => {
      const result = transform("function foo(a) { return a; }", { skipTscptrDeclarations: true });
      expect(result).toContain("__tscptr__.ret(a,");
    });

    it("wraps arrow expression body with __tscptr__.ret", () => {
      const result = transform("const fn = (x) => x + 1;", { skipTscptrDeclarations: true });
      expect(result).toContain("__tscptr__.ret(");
    });

    it("wraps arrow block body return with __tscptr__.ret", () => {
      const result = transform("const fn = (x) => { return x; };", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain("__tscptr__.ret(x,");
    });

    it("wraps method return with __tscptr__.ret", () => {
      const result = transform("class Foo { bar(a) { return a; } }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain("__tscptr__.ret(a,");
    });

    it("skips functions that already have a return type", () => {
      const result = transform("function foo(a): string { return a; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).not.toContain("__tscptr__.ret");
    });

    it("skips constructors", () => {
      const result = transform("class Foo { constructor(a) { this.a = a; return; } }", {
        skipTscptrDeclarations: true,
      });
      expect(result).not.toContain("__tscptr__.ret");
    });

    it("skips generator functions", () => {
      const result = transform("function* gen(a) { yield a; return a; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).not.toContain("__tscptr__.ret");
    });

    it("does not wrap return statements of nested functions", () => {
      const result = transform(
        "function outer(a) { function inner(b): string { return b; } return inner(a); }",
        { skipTscptrDeclarations: true },
      );
      // inner has return type → no wrapping
      // outer's return should be wrapped
      expect(result).toContain("__tscptr__.ret(inner(a)");
    });

    it("includes returnType flag in opts", () => {
      const result = transform("function foo(a) { return a; }", { skipTscptrDeclarations: true });
      expect(result).toContain('\\"returnType\\":true');
    });

    it("includes async flag for async functions", () => {
      const result = transform("async function foo(a) { return a; }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('\\"async\\":true');
    });

    it("includes async flag for async arrow functions", () => {
      const result = transform("const fn = async (x) => x + 1;", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain('\\"async\\":true');
    });

    it("skips bare return statements (return;)", () => {
      const result = transform("function foo(a) { if (!a) return; return a; }", {
        skipTscptrDeclarations: true,
      });
      // The bare return should not be wrapped, but the value return should
      expect(result).toContain("__tscptr__.ret(a,");
      // Count occurrences — should only be one __tscptr__.ret
      const retCount = (result.match(/__tscptr__\.ret\(/g) || []).length;
      expect(retCount).toBe(1);
    });

    it("records position after closing paren of parameter list", () => {
      // "function foo(a) { return a; }" — ')' is at position 14, so retPos = 15
      const result = transform("function foo(a) { return a; }", { skipTscptrDeclarations: true });
      // The ret call should contain position 15
      expect(result).toMatch(/__tscptr__\.ret\(a, 15,/);
    });

    it("records retPos at param-name end for paren-less arrow", () => {
      // "x => x + 1" — there's no `)` to anchor to, so a naive forward-
      // scan would walk past the function's own bounds (or to the end of
      // the file) and produce a retPos that lands inside unrelated
      // downstream code. Apply would then splice `: T` into the middle
      // of an unrelated statement (`inc(5): number;`). Use param-list
      // end (1, just after `x`) instead.
      const result = transform("const inc = x => x + 1;\ninc(5);", {
        skipTscptrDeclarations: true,
      });
      // Param `x` ends at offset 13; that's the retPos we want.
      expect(result).toMatch(/__tscptr__\.ret\(x \+ 1, 13,/);
    });

    it("adds ret declaration to __tscptr__ namespace", () => {
      const result = transform("const x = 1;");
      expect(result).toContain("function ret");
    });

    it("emits registerFn for named function declarations", () => {
      const result = transform("function foo(a) { return a; }", { skipTscptrDeclarations: true });
      expect(result).toContain("__tscptr__.registerFn(foo,");
    });

    it("includes fnRetPos in parameter opts", () => {
      const result = transform("function foo(a) { return a; }", { skipTscptrDeclarations: true });
      expect(result).toContain('\\"fnRetPos\\"');
    });

    it("does not emit registerFn for anonymous arrows", () => {
      const result = transform("const fn = (x) => x;", { skipTscptrDeclarations: true });
      expect(result).not.toContain("registerFn");
    });
  });

  describe("param-invocation return-type wrapping", () => {
    // When a function parameter is invoked inside the function body, the
    // call's return value is observed and attributed to the param's slot.
    // Lets apply emit `cb(x: T): R` instead of `cb(x: T): unknown` for
    // callback params whose caller is otherwise un-observable to ts-capture
    // (uninstrumented modules, external libs, test fixtures).

    it("wraps invocation of a simple param with __tscptr__.ret tagged paramReturn", () => {
      const result = transform("function foo(cb) { return cb(1); }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain("__tscptr__.ret(cb(1)");
      expect(result).toContain('\\"paramReturn\\":true');
      expect(result).toContain('\\"paramReturnMember\\":\\"cb\\"');
    });

    it("attributes paramReturn to the param's observation pos", () => {
      // "function foo(cb) { return cb(1); }"
      //               ^ cb at 13, getEnd() = 15. Observation pos = 15.
      const result = transform("function foo(cb) { return cb(1); }", {
        skipTscptrDeclarations: true,
      });
      // The paramReturn wrap should reference pos 15 (the param's obs pos),
      // not the function's retPos.
      const match = result.match(/__tscptr__\.ret\(cb\(1\), (\d+)/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("15");
    });

    it("wraps invocation of a destructured-object member param", () => {
      const result = transform("function Card({ title, render }) { return render(title); }", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain("__tscptr__.ret(render(title)");
      expect(result).toContain('\\"paramReturnMember\\":\\"render\\"');
    });

    it("does not wrap calls to non-param identifiers", () => {
      const result = transform("function foo(cb) { return Math.max(1, 2); }", {
        skipTscptrDeclarations: true,
      });
      // The Math.max call should not be wrapped as paramReturn.
      expect(result).not.toContain('\\"paramReturn\\":true');
    });

    it("does not wrap nested-function param invocations against outer params", () => {
      // outer's `cb` is shadowed by inner's `cb`. The inner call should
      // attribute to inner's param obs pos, not outer's.
      const result = transform(
        "function outer(cb) { function inner(cb) { return cb(1); } return inner(2); }",
        { skipTscptrDeclarations: true },
      );
      // Inner's cb invocation should be wrapped (it's still a param invocation).
      expect(result).toContain("__tscptr__.ret(cb(1)");
      // The wrap must use inner's cb pos. Inner starts after outer's
      // "function outer(cb) { ", so its `cb` is at a different position
      // than outer's. We assert there's exactly one paramReturn wrap
      // (for inner's cb only; outer's cb is never called).
      const paramRetCount = (result.match(/\\"paramReturn\\":true/g) || []).length;
      expect(paramRetCount).toBe(1);
    });

    it("wraps param invocations in arrow function bodies", () => {
      const result = transform("const f = (cb) => cb(1);", {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain("__tscptr__.ret(cb(1)");
      expect(result).toContain('\\"paramReturnMember\\":\\"cb\\"');
    });

    it("does not wrap params that have an explicit type annotation", () => {
      const result = transform("function foo(cb: () => string) { return cb(); }", {
        skipTscptrDeclarations: true,
      });
      // Typed params shouldn't trigger paramReturn — the user already
      // told us the return type.
      expect(result).not.toContain('\\"paramReturn\\":true');
    });
  });

  describe("variable declaration instrumentation", () => {
    it("wraps let initializer with __tscptr__.ret", () => {
      const result = transform("let x = 5;", { skipTscptrDeclarations: true });
      expect(result).toContain("__tscptr__.ret(5,");
    });

    it("wraps const initializer with __tscptr__.ret", () => {
      const result = transform('const name = "hello";', { skipTscptrDeclarations: true });
      expect(result).toContain("__tscptr__.ret(");
    });

    it("skips variable declarations with type annotations", () => {
      const result = transform("let x: number = 5;", { skipTscptrDeclarations: true });
      expect(result).not.toContain("__tscptr__.ret");
    });

    it("skips variable declarations without initializer", () => {
      const result = transform("let x;", { skipTscptrDeclarations: true });
      expect(result).not.toContain("__tscptr__.ret");
    });

    it("skips destructuring declarations", () => {
      const result = transform("const { a, b } = obj;", { skipTscptrDeclarations: true });
      expect(result).not.toContain("__tscptr__.ret");
    });

    it("includes varDecl flag in opts", () => {
      const result = transform("let x = 5;", { skipTscptrDeclarations: true });
      expect(result).toContain('\\"varDecl\\":true');
    });

    it("records position after variable name", () => {
      // "let x = 5;" — 'x' ends at position 5
      const result = transform("let x = 5;", { skipTscptrDeclarations: true });
      expect(result).toMatch(/__tscptr__\.ret\(5, 5,/);
    });

    // When the user writes `const w = window as MyWindow`, they've
    // explicitly told TypeScript to treat the value as MyWindow
    // regardless of its runtime shape. ts-capture observing the
    // runtime value (which under jsdom is a 6KB wall of synthetics)
    // overrides the user's intent and produces structural types that
    // don't match the cast. Mark such varDecls with `hasAsCast: true`
    // so apply can honor the user's cast.
    describe("hasAsCast flag on `as` / `<T>` casts", () => {
      it("marks RHS with `as Type` cast", () => {
        const result = transform("const w = window as MyWindow;", {
          skipTscptrDeclarations: true,
        });
        expect(result).toContain("__tscptr__.ret");
        expect(result).toContain('\\"hasAsCast\\":true');
      });

      it("marks RHS with `<Type>` prefix cast", () => {
        const result = transform("const w = <MyWindow>window;", {
          skipTscptrDeclarations: true,
        });
        expect(result).toContain("__tscptr__.ret");
        expect(result).toContain('\\"hasAsCast\\":true');
      });

      it("does NOT mark RHS without a cast", () => {
        const result = transform("const w = window;", { skipTscptrDeclarations: true });
        expect(result).toContain("__tscptr__.ret");
        expect(result).not.toContain("hasAsCast");
      });

      it("marks even when the cast is wrapped in parens: `(x as T)`", () => {
        const result = transform("const w = (window as MyWindow);", {
          skipTscptrDeclarations: true,
        });
        expect(result).toContain('\\"hasAsCast\\":true');
      });
    });
  });

  describe("class property instrumentation", () => {
    it("wraps class property initializer with __tscptr__.ret", () => {
      const result = transform('class Foo { name = "hello"; }', {
        skipTscptrDeclarations: true,
      });
      expect(result).toContain("__tscptr__.ret(");
    });

    it("skips class properties with type annotations", () => {
      const result = transform('class Foo { name: string = "hello"; }', {
        skipTscptrDeclarations: true,
      });
      expect(result).not.toContain("__tscptr__.ret");
    });

    it("skips class properties without initializer", () => {
      const result = transform("class Foo { name; }", { skipTscptrDeclarations: true });
      expect(result).not.toContain("__tscptr__.ret");
    });
  });

  describe("position tracking", () => {
    it("records correct offset for type insertion", () => {
      // "function foo(a) {}" — 'a' ends at position 14, so type goes at 14
      const source = "function foo(a) {}";
      const result = transform(source, { skipTscptrDeclarations: true });
      expect(result).toContain("14");
    });

    it("accounts for optional parameter marker in offset", () => {
      // "function foo(a?) {}" — 'a' ends at 14, '?' at 15, type goes at 15
      const source = "function foo(a?) {}";
      const result = transform(source, { skipTscptrDeclarations: true });
      expect(result).toContain("15");
    });
  });
});
