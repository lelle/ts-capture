import { describe, expect, it } from "vitest";

import type { InstrumentOptions } from "./transformer.js";

import {
  endOf,
  type Instrumented,
  instrumented,
  type InstrumentedSource,
  spanOf,
} from "./test-utils/instrumented.js";
import "./test-utils/matchers.js";

/** Instrument without the runtime declarations; only their own tests are about them. */
function transform(source: string, options: InstrumentOptions = {}): InstrumentedSource {
  return instrumented(source, { options: { skipTscptrDeclarations: true, ...options } });
}

const formsOf = (out: Instrumented): string[] => out.calls.map((call) => call.form);
const callbackReturns = (out: Instrumented): string[] =>
  out.calls.filter((call) => call.options.paramReturn).map((call) => call.valueText);

describe("transformer", () => {
  describe("__tscptr__ declarations", () => {
    it("adds __tscptr__ declarations to the source file", () => {
      const out = transform("const x = 1;", { skipTscptrDeclarations: false });
      expect(out).toDeclareRuntime();
      expect(out).toDeclareRuntime("track");
    });

    it("skips declarations when skipTscptrDeclarations is true", () => {
      const out = transform("const x = 1;");
      expect(out).not.toDeclareRuntime();
    });
  });

  describe("function parameters", () => {
    it("instruments unannotated parameter", () => {
      const out = transform("function foo(a) { return a; }");
      expect(out).toTrack("a", { in: "test.ts" });
    });

    it("instruments multiple unannotated parameters", () => {
      const out = transform("function foo(a, b) { return a + b; }");
      expect(out).toTrack("a");
      expect(out).toTrack("b");
    });

    it("skips parameters that already have a type", () => {
      const out = transform("function foo(a: string) { return a; }");
      expect(out).toLeaveUntracked("a");
    });

    it("skips parameters with default values", () => {
      const out = transform("function foo(a = 12) { return a; }");
      expect(out).toLeaveUntracked("a");
    });

    it("instruments only unannotated params in mixed declarations", () => {
      const out = transform("function foo(a: string, b) { return a + b; }");
      expect(out).toLeaveUntracked("a");
      expect(out).toTrack("b");
    });

    it("does not instrument function without body", () => {
      const out = transform("declare function foo(a: number): void;");
      expect(out).toLeaveUnchanged();
    });

    it("handles optional parameters", () => {
      const out = transform("function foo(a?) { return a; }");
      expect(out).toTrack("a");
    });

    it("handles destructured parameters", () => {
      const out = transform("function foo({ a, b }) { return a; }");
      expect(out).toTrack("{ a, b }");
    });

    it("handles rest parameters", () => {
      const out = transform("function foo(...args) { return args; }");
      expect(out).toTrack("args");
    });
  });

  describe("method parameters", () => {
    it("instruments class method parameters", () => {
      const out = transform("class Foo { bar(a) { return a; } }");
      expect(out).toTrack("a");
    });

    it("instruments constructor parameters", () => {
      const out = transform("class Foo { constructor(a) { this.a = a; } }");
      expect(out).toTrack("a");
    });
  });

  describe("arrow functions", () => {
    it("instruments arrow function with block body", () => {
      const out = transform("const fn = (x) => { return x; };");
      expect(out).toTrack("x", { arrow: true });
    });

    it("instruments arrow function with expression body", () => {
      const out = transform("const fn = (x) => x + 1;");
      expect(out).toTrack("x", { arrow: true });
    });

    it("handles arrow function without parens (single param)", () => {
      const out = transform("const fn = x => x + 1;");
      expect(out).toTrack("x", { parens: spanOf(out.input, "x") });
    });

    it("handles async arrow function without parens", () => {
      const out = transform("const fn = async x => x + 1;");
      expect(out).toTrack("x", { parens: spanOf(out.input, "x") });
    });

    it("instruments nested arrow functions", () => {
      const out = transform("const fn = (x) => (y) => x + y;");
      expect(out).toTrack("x");
      expect(out).toTrack("y");
    });

    // Paren-less arrow callback nested inside a call expression (the
    // `forEach(x => ...)` pattern). A non-defensive
    // `hasParensAroundArguments` crashes here with "Cannot read property
    // 'text' of undefined" when the arg lookup walks off the end of the
    // call's children. ts-capture's transformer must instrument this
    // without crashing AND emit the parens info so apply-types can wrap
    // `x` correctly.
    it("instruments paren-less arrow callback inside a call expression", () => {
      const out = transform("[1,2,3].forEach(x => console.log(x));");
      expect(out).toTrack("x", { parens: spanOf(out.input, "x") });
    });

    // Stress test: deeply nested paren-less arrows inside calls, mixed
    // with method-chain access. If ts-capture's parens detection walks
    // AST children non-defensively, this is where it'd crash.
    it("does not crash on deeply nested paren-less arrows in method chains", () => {
      const out = transform(
        "[1,2,3].map(x => x + 1).filter(y => y > 0).reduce((acc, n) => acc + n, 0);",
      );
      for (const name of ["x", "y", "acc", "n"]) expect(out).toTrack(name);
    });
  });

  describe("instrumentCallExpressions", () => {
    it("wraps non-literal call arguments with __tscptr__.track", () => {
      const out = transform("foo(bar)", {
        instrumentCallExpressions: true,
      });
      expect(out).toTrackArgument("bar");
    });

    it("does not wrap string literal arguments", () => {
      const out = transform('foo("bar")', {
        instrumentCallExpressions: true,
      });
      expect(out).toLeaveUnchanged();
    });

    it("does not wrap numeric literal arguments", () => {
      const out = transform("foo(42)", {
        instrumentCallExpressions: true,
      });
      expect(out).toLeaveUnchanged();
    });

    it("does not wrap spread arguments", () => {
      const out = transform("foo(...args)", {
        instrumentCallExpressions: true,
      });
      expect(out).toLeaveUnchanged();
    });

    it("does not wrap require.context calls", () => {
      const out = transform("require.context('./dir')", {
        instrumentCallExpressions: true,
      });
      expect(out).toLeaveUnchanged();
    });

    it("is disabled by default", () => {
      const out = transform("foo(bar)");
      expect(out).toLeaveUnchanged();
    });
  });

  describe("return type instrumentation", () => {
    it("wraps return expression with __tscptr__.ret", () => {
      const out = transform("function foo(a) { return a; }");
      expect(out).toWrapReturnOf("foo");
    });

    it("wraps arrow expression body with __tscptr__.ret", () => {
      const out = transform("const fn = (x) => x + 1;");
      expect(out).toWrapReturnOf("fn");
    });

    it("wraps arrow block body return with __tscptr__.ret", () => {
      const out = transform("const fn = (x) => { return x; };");
      expect(out).toWrapReturnOf("fn");
    });

    it("wraps method return with __tscptr__.ret", () => {
      const out = transform("class Foo { bar(a) { return a; } }");
      expect(out).toWrapReturnOf("bar");
    });

    it("skips functions that already have a return type", () => {
      const out = transform("function foo(a): string { return a; }");
      expect(out).not.toWrapReturnOf("foo");
    });

    it("skips constructors", () => {
      const out = transform("class Foo { constructor(a) { this.a = a; return; } }");
      expect(formsOf(out)).not.toContain("ret");
    });

    it("skips generator functions", () => {
      const out = transform("function* gen(a) { yield a; return a; }");
      expect(out).not.toWrapReturnOf("gen");
    });

    it("does not wrap return statements of nested functions", () => {
      const out = transform(
        "function outer(a) { function inner(b): string { return b; } return inner(a); }",
      );
      expect(out).toWrapReturnOf("outer");
      expect(out).not.toWrapReturnOf("inner");
    });

    it("includes returnType flag in opts", () => {
      const out = transform("function foo(a) { return a; }");
      expect(out).toWrapReturnOf("foo", { returnType: true });
    });

    it("includes async flag for async functions", () => {
      const out = transform("async function foo(a) { return a; }");
      expect(out).toWrapReturnOf("foo", { async: true });
    });

    it("includes async flag for async arrow functions", () => {
      const out = transform("const fn = async (x) => x + 1;");
      expect(out).toWrapReturnOf("fn", { async: true });
    });

    it("skips bare return statements (return;)", () => {
      const out = transform("function foo(a) { if (!a) return; return a; }");
      expect(out).toWrapReturnOf("foo");
      // One wrap, for the return that has a value.
      expect(formsOf(out).filter((form) => form === "ret")).toHaveLength(1);
    });

    it("records position after closing paren of parameter list", () => {
      const out = transform("function foo(a) { return a; }");
      expect(out).toWrapReturnOf("foo", { at: endOf(out.input, "foo(a)") });
    });

    it("records retPos at param-name end for paren-less arrow", () => {
      // "x => x + 1" — there's no `)` to anchor to, so a naive forward-
      // scan would walk past the function's own bounds (or to the end of
      // the file) and produce a retPos that lands inside unrelated
      // downstream code. Apply would then splice `: T` into the middle
      // of an unrelated statement (`inc(5): number;`). Use param-list
      // end (1, just after `x`) instead.
      const out = transform("const inc = x => x + 1;\ninc(5);");
      expect(out).toWrapReturnOf("inc", { at: endOf(out.input, "inc = x") });
    });

    it("adds ret declaration to __tscptr__ namespace", () => {
      const out = transform("const x = 1;", { skipTscptrDeclarations: false });
      expect(out).toDeclareRuntime("ret");
    });

    it("emits registerFn for named function declarations", () => {
      const out = transform("function foo(a) { return a; }");
      expect(out).toRegisterFunction("foo");
    });

    it("includes fnRetPos in parameter opts", () => {
      const out = transform("function foo(a) { return a; }");
      expect(out).toTrack("a", { fnRetPos: endOf(out.input, "foo(a)") });
    });

    it("does not emit registerFn for anonymous arrows", () => {
      const out = transform("const fn = (x) => x;");
      expect(formsOf(out)).not.toContain("registerFn");
    });
  });

  describe("param-invocation return-type wrapping", () => {
    // When a function parameter is invoked inside the function body, the
    // call's return value is observed and attributed to the param's slot.
    // Lets apply emit `cb(x: T): R` instead of `cb(x: T): unknown` for
    // callback params whose caller is otherwise un-observable to ts-capture
    // (uninstrumented modules, external libs, test fixtures).

    it("wraps invocation of a simple param with __tscptr__.ret tagged paramReturn", () => {
      const out = transform("function foo(cb) { return cb(1); }");
      expect(out).toWrapCallsOf("cb");
    });

    it("attributes paramReturn to the param's observation pos", () => {
      // Where the parameter's own observation is keyed, not the function's return.
      const out = transform("function foo(cb) { return cb(1); }");
      expect(out).toWrapCallsOf("cb", { at: endOf(out.input, "foo(cb") });
    });

    it("wraps invocation of a destructured-object member param", () => {
      const out = transform("function Card({ title, render }) { return render(title); }");
      expect(out).toWrapCallsOf("render");
    });

    it("does not wrap calls to non-param identifiers", () => {
      const out = transform("function foo(cb) { return Math.max(1, 2); }");
      expect(callbackReturns(out)).toEqual([]);
    });

    it("does not wrap nested-function param invocations against outer params", () => {
      // outer's `cb` is shadowed by inner's `cb`. The inner call should
      // attribute to inner's param obs pos, not outer's.
      const out = transform(
        "function outer(cb) { function inner(cb) { return cb(1); } return inner(2); }",
      );
      // One wrap, for inner's cb; outer's cb is never called.
      expect(out).toWrapCallsOf("cb", { at: endOf(out.input, "inner(cb") });
      expect(callbackReturns(out)).toEqual(["cb(1)"]);
    });

    it("wraps param invocations in arrow function bodies", () => {
      const out = transform("const f = (cb) => cb(1);");
      expect(out).toWrapCallsOf("cb");
    });

    it("does not wrap params that have an explicit type annotation", () => {
      const out = transform("function foo(cb: () => string) { return cb(); }");
      // Typed params shouldn't trigger paramReturn — the user already
      // told us the return type.
      expect(callbackReturns(out)).toEqual([]);
    });
  });

  describe("variable declaration instrumentation", () => {
    it("wraps let initializer with __tscptr__.ret", () => {
      const out = transform("let x = 5;");
      expect(out).toWrapInitializerOf("x");
    });

    it("wraps const initializer with __tscptr__.ret", () => {
      const out = transform('const name = "hello";');
      expect(out).toWrapInitializerOf("name");
    });

    it("skips variable declarations with type annotations", () => {
      const out = transform("let x: number = 5;");
      expect(out).toLeaveUnchanged();
    });

    it("skips variable declarations without initializer", () => {
      const out = transform("let x;");
      expect(out).toLeaveUnchanged();
    });

    it("tracks destructuring declarations after the statement", () => {
      const out = transform("const { a, b } = obj;");
      expect(formsOf(out)).toEqual(["param"]);
      expect(out).toTrack("{ a, b }", { varDecl: true, at: endOf(out.input, "{ a, b }") });
      expect(out.calls[0]!.valueText).toBe("{ a, b }");
    });

    it("includes varDecl flag in opts", () => {
      const out = transform("let x = 5;");
      expect(out).toWrapInitializerOf("x", { varDecl: true });
    });

    it("records position after variable name", () => {
      const out = transform("let x = 5;");
      expect(out).toWrapInitializerOf("x", { at: endOf(out.input, "let x") });
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
        const out = transform("const w = window as MyWindow;");
        expect(out).toWrapInitializerOf("w", { hasAsCast: true });
      });

      it("marks RHS with `<Type>` prefix cast", () => {
        const out = transform("const w = <MyWindow>window;");
        expect(out).toWrapInitializerOf("w", { hasAsCast: true });
      });

      it("does NOT mark RHS without a cast", () => {
        const out = transform("const w = window;");
        expect(out).toWrapInitializerOf("w", { hasAsCast: undefined });
      });

      it("marks even when the cast is wrapped in parens: `(x as T)`", () => {
        const out = transform("const w = (window as MyWindow);");
        expect(out).toWrapInitializerOf("w", { hasAsCast: true });
      });
    });
  });

  describe("class property instrumentation", () => {
    it("wraps class property initializer with __tscptr__.ret", () => {
      const out = transform('class Foo { name = "hello"; }');
      expect(out).toWrapInitializerOf("name");
    });

    it("skips class properties with type annotations", () => {
      const out = transform('class Foo { name: string = "hello"; }');
      expect(out).toLeaveUnchanged();
    });

    it("skips class properties without initializer", () => {
      const out = transform("class Foo { name; }");
      expect(out).toLeaveUnchanged();
    });
  });

  describe("observeAnnotated", () => {
    const observing = (source: string): InstrumentedSource =>
      transform(source, { observeAnnotated: true });

    it("tracks a typed parameter, marked annotated", () => {
      const out = observing("function foo(a: string) { return a; }");
      expect(out).toTrack("a", { annotated: true, at: endOf(out.input, "foo(a") });
    });

    it("does not mark an untyped parameter beside it", () => {
      const out = observing("function foo(a: string, b) { return a + b; }");
      const b = out.calls.find((call) => call.name === "b");
      expect(b?.options.annotated).toBeUndefined();
    });

    it("wraps the return of a function with a return type, marked annotated", () => {
      const out = observing("function foo(a): string { return a; }");
      expect(out).toWrapReturnOf("foo", { annotated: true, at: endOf(out.input, "foo(a)") });
    });

    it("wraps the return of an arrow with a return type, marked annotated", () => {
      const out = observing("const foo = (a: number): string => String(a);");
      expect(out).toWrapReturnOf("foo", { annotated: true });
      expect(out).toTrack("a", { annotated: true });
    });

    it("records what a typed parameter was passed", () => {
      const out = observing("function total(qty: string) { return qty; }");
      expect(out.run({ total: [2] })).toObserve("qty", "number");
    });

    it("still skips a typed parameter with a default value", () => {
      const out = observing("function foo(a: number = 1) { return a; }");
      expect(out).toLeaveUntracked("a");
    });

    it("does not wrap calls of a typed callback parameter", () => {
      const out = observing("function foo(cb: () => string) { return cb(); }");
      expect(callbackReturns(out)).toEqual([]);
    });

    it("leaves typed variables and class fields alone", () => {
      const out = observing('let x: number = 5; class C { name: string = "a"; }');
      expect(out).toLeaveUnchanged();
    });
  });

  describe("position tracking", () => {
    it("records correct offset for type insertion", () => {
      const source = "function foo(a) {}";
      const out = transform(source);
      expect(out).toTrack("a", { at: endOf(out.input, "foo(a") });
    });

    it("accounts for optional parameter marker in offset", () => {
      // The type goes after the `?`.
      const source = "function foo(a?) {}";
      const out = transform(source);
      expect(out).toTrack("a", { at: endOf(out.input, "foo(a?") });
    });
  });
});
