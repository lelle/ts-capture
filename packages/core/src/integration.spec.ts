import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { ApplyTypesOptions } from "./contract.js";
import type { ExtraOptions, LiteralOptions } from "./type-collector.js";

import { applyTypesToFileCst } from "./apply-types-cst.js";
import { applyTypesToFile } from "./apply-types.js";
import { INFER_DEFAULTS } from "./configuration.js";
import { instrumentSource } from "./instrument.js";
import { createCollectionContext, getTypeName } from "./type-collector.js";

/**
 * End-to-end pipeline: instrument → transpile → execute → collect → apply.
 *
 * Instead of the original's global __tscptr__ + vm snippet approach, we build
 * a sandbox that wires __tscptr__ to a CollectionContext, execute the transpiled
 * code, then apply the collected types back to the original source.
 */
function runPipeline(
  input: string,
  opts: { collector?: LiteralOptions; apply?: ApplyTypesOptions } = {},
): string | null {
  // Step 1: instrument
  const instrumented = instrumentSource(input, "test.ts", {
    instrumentCallExpressions: true,
  });

  // Step 2: transpile to runnable JS
  const compiled = ts.transpile(instrumented, {
    target: ts.ScriptTarget.ES2015,
  });

  // Step 3: execute with type collector in a sandbox
  const ctx = createCollectionContext({ literalOptions: opts.collector });

  const __tscptr__ = function (
    name: string,
    value: unknown,
    pos: number,
    filename: string,
    optsJson: string,
  ) {
    const opts = JSON.parse(optsJson) as ExtraOptions;
    ctx.record(name, value, pos, filename, opts);
  };
  __tscptr__.track = function <T>(value: T, filename: string, offset: number): T {
    return ctx.track(value, filename, offset);
  };
  __tscptr__.ret = function <T>(value: T, pos: number, filename: string, optsJson: string): T {
    const opts = JSON.parse(optsJson) as ExtraOptions;
    ctx.record("(return)", value, pos, filename, opts);
    return value;
  };
  __tscptr__.registerFn = function (fn: Function, retPos: number, filename: string) {
    ctx.registerFn(fn, retPos, filename);
  };
  __tscptr__.regFn = function <T extends Function>(fn: T, retPos: number, filename: string): T {
    ctx.registerFn(fn, retPos, filename);
    return fn;
  };
  __tscptr__.typeName = getTypeName;
  __tscptr__.get = () => ctx.getCollectedTypes();

  const sandbox = { __tscptr__, console, Array, Object, Promise, RegExp, Map, Set };
  vm.runInNewContext(compiled, sandbox);

  // Step 4: apply types
  const collectedTypes = ctx.getCollectedTypes();

  // Filter to entries for our file
  const fileTypes = collectedTypes.filter(([f]) => f === "test.ts");
  if (fileTypes.length === 0) return null;

  const applyOptions = opts.apply ?? {};
  const apply = applyOptions.infer?.cstAware ? applyTypesToFileCst : applyTypesToFile;
  return apply(input, fileTypes, applyOptions);
}

/**
 * TSX variant of runPipeline. Identical setup but:
 *   - filename is "test.tsx" (instrument infers TSX from extension)
 *   - transpile uses classic React JsxEmit so `<div/>` becomes
 *     `React.createElement('div', null)`; `<>x</>` becomes
 *     `React.createElement(React.Fragment, null, "x")`
 *   - sandbox gets a `React` stub (createElement returns a plain
 *     object, doesn't render). Inner arrows inside JSX attribute
 *     values are NOT invoked (no DOM event loop) — observations
 *     only land for arrows actually called during component-body
 *     execution: `items.map(item => …)`, function-as-child the
 *     parent invokes, etc.
 */
function runPipelineTsx(
  input: string,
  opts: { collector?: LiteralOptions; apply?: ApplyTypesOptions } = {},
): string | null {
  const filename = "test.tsx";
  const instrumented = instrumentSource(input, filename, {
    instrumentCallExpressions: true,
  });
  const compiled = ts.transpile(instrumented, {
    target: ts.ScriptTarget.ES2015,
    jsx: ts.JsxEmit.React,
  });

  const ctx = createCollectionContext({ literalOptions: opts.collector });

  const __tscptr__ = function (
    name: string,
    value: unknown,
    pos: number,
    fname: string,
    optsJson: string,
  ) {
    const o = JSON.parse(optsJson) as ExtraOptions;
    ctx.record(name, value, pos, fname, o);
  };
  __tscptr__.track = function <T>(value: T, fname: string, offset: number): T {
    return ctx.track(value, fname, offset);
  };
  __tscptr__.ret = function <T>(value: T, pos: number, fname: string, optsJson: string): T {
    const o = JSON.parse(optsJson) as ExtraOptions;
    ctx.record("(return)", value, pos, fname, o);
    return value;
  };
  __tscptr__.registerFn = function (fn: Function, retPos: number, fname: string) {
    ctx.registerFn(fn, retPos, fname);
  };
  __tscptr__.regFn = function <T extends Function>(fn: T, retPos: number, fname: string): T {
    ctx.registerFn(fn, retPos, fname);
    return fn;
  };
  __tscptr__.typeName = getTypeName;
  __tscptr__.get = () => ctx.getCollectedTypes();

  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      $$typeof: Symbol.for("test.element"),
      type,
      props: props ?? {},
      children,
    }),
    Fragment: Symbol.for("test.fragment"),
  };

  const sandbox = { __tscptr__, console, Array, Object, Promise, RegExp, Map, Set, React };
  vm.runInNewContext(compiled, sandbox);

  const collectedTypes = ctx.getCollectedTypes();
  const fileTypes = collectedTypes.filter(([f]) => f === filename);
  if (fileTypes.length === 0) return null;

  const applyOptions = opts.apply ?? {};
  const apply = applyOptions.infer?.cstAware ? applyTypesToFileCst : applyTypesToFile;
  return apply(input, fileTypes, applyOptions);
}

describe("integration: full pipeline", () => {
  it("infers string type for a simple function", () => {
    const input = `
function greet(c) {
    return 'Hello ' + c;
}
greet('World');`;

    expect(runPipeline(input)).toBe(`
function greet(c: string): string {
    return 'Hello ' + c;
}
greet('World');`);
  });

  it("infers number type for arrow function", () => {
    const input = `((x) => { return x + 5; })(10)`;
    expect(runPipeline(input)).toBe(`((x: number): number => { return x + 5; })(10)`);
  });

  it("infers types for class methods", () => {
    const input = `
class Greeter {
    greet(who) {
        return 'Hello, ' + who;
    }
}
new Greeter().greet('World');`;

    expect(runPipeline(input)).toBe(`
class Greeter {
    greet(who: string): string {
        return 'Hello, ' + who;
    }
}
new Greeter().greet('World');`);
  });

  it("creates union types from multiple calls", () => {
    const input = `
function commas(item) {
    return Array.from(item).join(', ');
}
commas('Lavender');
commas(['Apples', 'Oranges']);`;

    const result = runPipeline(input);
    expect(result).toContain("item: string|string[]");
  });

  it("handles optional parameters", () => {
    const input = `
function calculate(a, b?) {
    return a + (b || 0);
}
calculate(5, 6);`;

    const result = runPipeline(input)!;
    expect(result).toContain("a: number");
    expect(result).toContain("b?: number");
  });

  it("does not append undefined to optional params", () => {
    const input = `
function optional(b?, c?) {
    return b || 0;
}
optional() + optional(10);`;

    const result = runPipeline(input)!;
    expect(result).toContain("b?: number");
    // c? was never called with a value, so should remain untyped or be skipped
  });

  it("returns null for unused functions (no types collected)", () => {
    const input = `
function unused(foo, bar) {
}`;

    expect(runPipeline(input)).toBe(null);
  });

  it("infers object types", () => {
    const input = `
function foo(obj) { return obj; }
foo({hello: 'world'});`;

    const result = runPipeline(input)!;
    expect(result).toContain("obj: { hello: string }");
  });

  it("handles nested arrow functions", () => {
    const input = `
function doTheThing(cb) {
    cb([1,2,3]);
}
doTheThing((results) => {
    results.forEach((result) => console.log(result));
});`;

    const result = runPipeline(input)!;
    expect(result).toContain("cb:");
    expect(result).toContain("results: number[]");
    expect(result).toContain("result: number");
  });

  it("handles destructured parameters with defaults", () => {
    const input = `
function greet({ who = "" }) {
    return 'Hello, ' + who;
}
greet({who: 'world'});`;

    const result = runPipeline(input)!;
    expect(result).toContain('{ who = "" }: { who: string }');
  });
});

describe("integration: return type inference", () => {
  it("infers return type for simple function", () => {
    const input = `function double(x) { return x * 2; }\ndouble(5);`;
    const result = runPipeline(input)!;
    expect(result).toContain("x: number): number");
  });

  it("infers return type for arrow expression body", () => {
    const input = `const fn = (x) => x + 1;\nfn(5);`;
    const result = runPipeline(input)!;
    expect(result).toContain("x: number): number");
  });

  it("infers async return type wrapped in Promise", () => {
    const input = `async function fetchData(url) { return url.length; }\nfetchData("http://example.com");`;
    const result = runPipeline(input)!;
    expect(result).toContain("url: string): Promise<number>");
  });

  it("infers union return type from multiple code paths", () => {
    const input = `function maybe(x) { if (x > 0) return x; return "negative"; }\nmaybe(5);\nmaybe(-1);`;
    const result = runPipeline(input)!;
    expect(result).toContain("): number|string");
  });

  it("does not annotate return type for functions with existing return type", () => {
    const input = `function typed(x): string { return x; }\ntyped("hello");`;
    const result = runPipeline(input)!;
    // Should have param type but NOT a second return type
    expect(result).toContain("x: string): string");
    expect(result).not.toContain("): string): string");
  });

  it("infers return type for class methods", () => {
    const input = `
class Calculator {
    add(a, b) { return a + b; }
}
new Calculator().add(1, 2);`;
    const result = runPipeline(input)!;
    expect(result).toContain("): number");
  });
});

describe("integration: function cross-referencing", () => {
  it("infers specific callback type from collected parameter observations", () => {
    const input = `
function process(cb) {
    cb(42);
}
function double(x) { return x * 2; }
process(double);`;
    const result = runPipeline(input)!;
    // cb should have a specific type from double's observed signature
    expect(result).toContain("cb: (x: number) => number");
  });

  it("infers full signature for anonymous inline arrows passed as call args", () => {
    // Inline arrows have no `name` to register by, so `registerFn` can't
    // reach them — naively, the receiver's param type would stay
    // `fn: (x: unknown) => unknown`. The transformer wraps each
    // instrumented arrow with `__tscptr__.regFn(arrow, …)` which registers
    // the arrow VALUE at creation time, so the cross-reference logic
    // in `getCollectedTypes` upgrades to the full observed signature.
    const input = `
function apply(fn, val) {
    return fn(val);
}
apply((x) => x + 1, 5);`;
    const result = runPipeline(input)!;
    expect(result).toContain("fn: (x: number) => number");
  });

  it("infers callback type for named function expressions", () => {
    const input = `
function forEach(arr, callback) {
    for (const item of arr) callback(item);
}
function log(x) { return String(x); }
forEach([1, 2, 3], log);`;
    const result = runPipeline(input)!;
    expect(result).toContain("callback: (x: number) => string");
  });

  it("emits `@ts-capture:generic-fn` marker for un-invoked callback values", () => {
    // The callback `fn` is passed but never called inside `apply`'s
    // body, so its arrow body never runs and no params/return are
    // observed. regFn-wrap registers the arrow but `fnSignatures` has
    // no entry for its retPos → cross-ref upgrade fails → emit stays
    // `(x: unknown) => unknown` → marker fires.
    const input = `
function apply(fn, val) { return val; }
apply((x) => x + 1, 5);`;
    const result = runPipeline(input, {
      apply: {
        infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, emitDiagnosticComments: true },
      },
    })!;
    expect(result).toContain("/* @ts-capture:generic-fn */");
  });

  it("preserves generic function type when function is not instrumented", () => {
    const input = `
function apply(fn) {
    return fn(5);
}
apply(Math.floor);`;
    const result = runPipeline(input)!;
    // Math.floor is native, not instrumented — should stay as Function
    expect(result).toContain("fn: Function");
  });

  it("upgrades object-member callback return type from unknown", () => {
    // Pre-fix: when a function-valued property is inside a props object,
    // record() saw typeof value === "object" and never stored it in
    // recordedFunctions. The cross-ref upgrade in getCollectedTypes()
    // only looked at recordedFunctions, so the member stayed
    // `render(x: number): unknown` even though the arrow was registered
    // via regFn and its return type was observed.
    const input = `
function render(props) {
  return props.render(props.value);
}
render({ render: (x) => x * 2, value: 5 });`;
    const result = runPipeline(input)!;
    // The object literal should have its render member upgraded from
    // `render(x: unknown): unknown` to `render(x: number): number`
    expect(result).toContain("render(x: number): number");
  });

  it("upgrades multiple function members in the same object", () => {
    const input = `
function run(ops) {
  ops.double(ops.triple(2));
}
run({ double: (x) => x * 2, triple: (x) => x * 3 });`;
    const result = runPipeline(input)!;
    expect(result).toContain("double(x: number): number");
    expect(result).toContain("triple(x: number): number");
  });

  it("upgrades callback return type via invocation-site observation when parent isn't registered", () => {
    // The bound function `helper.bind(null)` is a NEW function not in
    // registeredFns — it's not the same reference as `helper` itself,
    // which is what registerFn captured. So the existing cross-ref
    // (recordedFunctions → registeredFns → fnSignatures) misses, and
    // without the paramReturn upgrade the param emitted
    // `cb: (x: unknown) => unknown`.
    //
    // The fix: the transformer wraps the `cb(...)` invocation inside
    // callbacker's body with `__tscptr__.ret(..., {paramReturn:true})`. The
    // collected return type (`number`) is substituted into the trailing
    // `unknown` of cb's emitted function signature, yielding `=> number`.
    const input = `
function callbacker(cb) {
    return cb(21);
}
function helper(x) { return x * 2; }
callbacker(helper.bind(null));`;
    const result = runPipeline(input)!;
    // Bound-function shape is `(...args: unknown[]) => unknown` from
    // getTypeName (bind erases param identities). The paramReturn upgrade
    // substitutes the trailing `unknown` → observed `number`.
    expect(result).toContain("(...args: unknown[]) => number");
  });

  it("widens sole-undefined return to void in cross-ref-emitted callback signatures", () => {
    // The arrow `(x) => { console.log(x) }` returns undefined. Its own
    // return-type annotation gets widened to `: void` by apply
    // (apply-types.ts:1122-1124). The cross-ref machinery that
    // upgrades the receiver's callback param must apply the same
    // widening — else the receiver expects `(x) => undefined` while
    // callers provide `(x) => void`, and TS rejects the variance.
    // Expression body so the arrow's return value (console.log's result,
    // which is `undefined`) is observed via the expression-wrap; block
    // bodies without explicit `return` don't trigger return instrumentation.
    const input = `
function listen(handler) {
  handler(1);
}
listen((x) => console.log(x));`;
    const result = runPipeline(input)!;
    expect(result).toContain("handler: (x: number) => void");
    expect(result).not.toContain("=> undefined");
  });

  it("widens undefined → void inside object-shape callback members", () => {
    // The destructured-prop variant. The object's `send` member is a
    // function returning undefined; the prop-shape should emit
    // `send(x: number): void`, not `send(x: number): undefined`.
    const input = `
function dispatch(api) {
  api.send(42);
}
dispatch({ send: (x) => console.log(x) });`;
    const result = runPipeline(input)!;
    expect(result).toContain("send(x: number): void");
  });

  it("does not override a specific parent-supplied return type with paramReturn (fallback only)", () => {
    // Same shape as the existing 'infers specific callback type' test
    // — process(double), where double is a named-fn with full sig
    // `(x: number) => number` from registeredFns. The paramReturn
    // observation for `cb(42)` is `number` (same value). The emit
    // already had the specific return; the paramReturn upgrade must
    // NOT replace it with a less precise one nor break the pipeline.
    const input = `
function process(cb) {
    cb(42);
}
function double(x) { return x * 2; }
process(double);`;
    const result = runPipeline(input)!;
    expect(result).toContain("cb: (x: number) => number");
  });
});

describe("integration: variable and property inference", () => {
  it("infers type for let declaration", () => {
    const input = `let x = 5;\nfunction use(a) { return a; }\nuse(x);`;
    const result = runPipeline(input)!;
    expect(result).toContain("let x: number = 5");
  });

  it("infers type for const declaration", () => {
    const input = `const name = "hello";\nfunction use(a) { return a; }\nuse(name);`;
    const result = runPipeline(input)!;
    expect(result).toContain('const name: string = "hello"');
  });

  it("infers type for class property", () => {
    const input = `
class Foo {
    value = 42;
    greet() { return this.value; }
}
new Foo().greet();`;
    const result = runPipeline(input)!;
    expect(result).toContain("value: number = 42");
  });

  it("does not annotate already-typed variables", () => {
    const input = `let x: number = 5;\nfunction use(a) { return a; }\nuse(x);`;
    const result = runPipeline(input)!;
    expect(result).toContain("let x: number = 5");
    // Should not have double annotation
    expect(result).not.toContain("x: number: number");
  });
});

describe("integration: edge cases from original", () => {
  it("infers object types with special keys", () => {
    const input = "function foo(obj) { return obj; }\n" + "foo({hello: 'world', 'foo-bar': 42});";
    const result = runPipeline(input)!;
    expect(result).toContain('obj: { "foo-bar": number, hello: string }');
  });

  it("does not crash on circular references", () => {
    const input = ["let a = {};", "a.a = a;", "function foo(obj) { return obj; }", "foo(a);"].join(
      "\n",
    );
    expect(() => runPipeline(input)).not.toThrow();
  });

  it("applies prefix option", () => {
    const input = "function greet(c) { return 'Hello ' + c; }\ngreet('World');";

    const instrumented = instrumentSource(input, "test.ts", { instrumentCallExpressions: true });
    const compiled = ts.transpile(instrumented, { target: ts.ScriptTarget.ES2015 });
    const ctx = createCollectionContext();
    const tscptr = function (
      name: string,
      value: unknown,
      pos: number,
      filename: string,
      optsJson: string,
    ) {
      ctx.record(name, value, pos, filename, JSON.parse(optsJson));
    };
    tscptr.track = function <T>(value: T, filename: string, offset: number): T {
      return ctx.track(value, filename, offset);
    };
    tscptr.ret = function <T>(value: T, pos: number, filename: string, optsJson: string): T {
      ctx.record("(return)", value, pos, filename, JSON.parse(optsJson));
      return value;
    };
    tscptr.registerFn = function (fn: Function, retPos: number, filename: string) {
      ctx.registerFn(fn, retPos, filename);
    };
    tscptr.regFn = function <T extends Function>(fn: T, retPos: number, filename: string): T {
      ctx.registerFn(fn, retPos, filename);
      return fn;
    };
    const sandbox = { __tscptr__: tscptr, console, Array, Object };
    vm.runInNewContext(compiled, sandbox);
    const types = ctx.getCollectedTypes().filter(([f]) => f === "test.ts");
    const result = applyTypesToFile(input, types, { prefix: "/*auto*/" });
    expect(result).toContain("c: /*auto*/string");
  });
});

// String-offset-based applies can drop a type at the wrong position —
// inside a destructure pattern, between a decorator and its target,
// mid-template-literal, etc. These probes pick representative AST
// position categories plus a few adjacent shapes; for each one, the
// apply output must parse as valid TypeScript. A bad position shows
// up as a SyntaxError, not a quiet type drift.
//
// Written as confirm-or-deny rather than known-fail: if any case here
// flips to FAIL, that's a concrete reproducer for the AST-position
// bug class to be promoted into a focused follow-up.
function expectParseable(source: string): void {
  const sf = ts.createSourceFile("check.ts", source, ts.ScriptTarget.Latest, true);
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  const errors = (diags ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const messages = errors
      .map((d) => `  - ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`)
      .join("\n");
    throw new Error(
      `Apply output failed to parse as TypeScript:\n${messages}\n\n--- source ---\n${source}\n--------------`,
    );
  }
}

describe("integration: AST-position bug class probes", () => {
  it("object destructure param: insertion at end of `}` produces parseable output", () => {
    const input = `
function readUser({ name, age }) {
    return name + age;
}
readUser({ name: 'a', age: 1 });`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toContain("{ name, age }:");
  });

  it("array destructure param: insertion at end of `]` produces parseable output", () => {
    const input = `
function pair([a, b]) {
    return a + b;
}
pair([1, 2]);`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toContain("[a, b]:");
  });

  it("nested object destructure: insertion at end of outer `}` produces parseable output", () => {
    const input = `
function deep({ outer: { inner } }) {
    return inner;
}
deep({ outer: { inner: 'x' } });`;
    const result = runPipeline(input)!;
    expectParseable(result);
  });

  it("rest inside object destructure produces parseable output", () => {
    const input = `
function spread({ a, ...rest }) {
    return a;
}
spread({ a: 1, b: 2, c: 3 });`;
    const result = runPipeline(input)!;
    expectParseable(result);
  });

  it("rest parameter: insertion at end of `args` produces parseable output", () => {
    const input = `
function sum(...args) {
    return args.reduce((a, b) => a + b, 0);
}
sum(1, 2, 3);`;
    const result = runPipeline(input)!;
    expectParseable(result);
    // ...args becomes ...args: T[] (or similar) — the insertion site is
    // the end of the binding name, not before "..."
    expect(result).toMatch(/\.\.\.args:\s*/);
  });

  it("constructor parameter property (public x) produces parseable output", () => {
    // TS sugar: `public` modifier on a constructor param both declares
    // and assigns to a class field. The transformer instruments the
    // param like any other; insertion at param.name.end should land
    // between the binding and any default value.
    const input = `
class Point {
    constructor(public x, public y) {}
}
new Point(1, 2);`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toMatch(/public x:\s*number/);
    expect(result).toMatch(/public y:\s*number/);
  });

  it("optional param `a?` inserts `?:` (questionToken offset handled)", () => {
    // Repro scenario: param.name.getEnd() is BEFORE the `?`, so the
    // transformer adds +1 to the offset to land after the `?`. If that
    // offset math broke, apply would write `a: T?` (invalid) instead
    // of `a?: T`.
    const input = `
function maybe(a?) {
    return a || 0;
}
maybe(); maybe(7);`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toContain("a?:");
  });

  it("paren-less single-param arrow: insertion wraps parens correctly", () => {
    // `x => body` has no parens around `x`. Apply must wrap the param
    // with parens AND insert the type, otherwise the output would be
    // `x: T => body` which is invalid TS. The `parens` opt +
    // wrap-injection handle this. The returnType-entry also lands at
    // the same paren-less arrow pos, so the matcher accepts either
    // `(x: number) =>` (param-only) or `(x: number): T =>`
    // (param + return) — both valid TS.
    const input = `
const inc = x => x + 1;
inc(5);`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toMatch(/\(x:\s*number\)\s*(?::[^=]+)?=>/);
  });

  it("class method with computed name produces parseable output", () => {
    // `class C { [key]() {} }` — method has computed name. param
    // positions still sit on the regular param identifiers; verify
    // the computed name doesn't push offsets into the wrong place.
    const input = `
const key = 'doStuff';
class C {
    [key](x) { return x; }
}
new C()[key](42);`;
    const result = runPipeline(input)!;
    expectParseable(result);
  });

  it("generator function parameter produces parseable output", () => {
    // `function* foo(x) { yield x; }` — generator `*` token sits
    // between `function` and the name. Param offset is independent;
    // insertion should be safe.
    const input = `
function* gen(x) {
    yield x;
}
const g = gen(1); g.next();`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toMatch(/gen\(x:\s*number\)/);
  });

  it("async generator function parameter produces parseable output", () => {
    const input = `
async function* agen(x) {
    yield x;
}
(async () => { const it = agen(1); await it.next(); })();`;
    const result = runPipeline(input)!;
    expectParseable(result);
  });

  it("object-literal method shorthand parameter produces parseable output", () => {
    // `const o = { foo(x) { ... } }` — MethodDeclaration on object
    // literal. Should be instrumented + applied like a class method.
    const input = `
const o = {
    foo(x) { return x * 2; },
};
o.foo(3);`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toMatch(/foo\(x:\s*number\)/);
  });

  it("decorated class with method param produces parseable output", () => {
    // `@decorator class Foo { method(x) {} }` — decorators sit on the
    // class declaration. Param offsets are inside the method body and
    // shouldn't be perturbed by the leading decorator. (Uses
    // experimental decorators syntax, which TS still parses without
    // the flag set; the test only checks parseability of apply output.)
    const input = `
function logged(target: any) { return target; }
@logged
class Box {
    set(x) { return x; }
}
new Box().set('hi');`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toMatch(/set\(x:\s*string\)/);
  });

  it("multi-line param list does not corrupt insertion offsets", () => {
    // Whitespace + newlines between params can confuse string-based
    // appliers if positions are computed from a different layout than
    // applied. param.name.getEnd() is the binding-name end, so it
    // should be invariant to surrounding trivia.
    const input = `
function multi(
    a,
    b,
    c
) {
    return a + b + c;
}
multi(1, 2, 3);`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toMatch(/a:\s*number/);
    expect(result).toMatch(/b:\s*number/);
    expect(result).toMatch(/c:\s*number/);
  });

  it("trailing comma in param list does not break insertion", () => {
    const input = `
function tail(
    a,
    b,
) {
    return a + b;
}
tail(1, 2);`;
    const result = runPipeline(input)!;
    expectParseable(result);
  });

  // Parameter decorator (legacy / experimentalDecorators syntax). TS
  // parses parameter decorators without the flag set — the flag
  // controls emit, not parsing — so apply just sees an extra
  // modifier-like node sitting immediately before the param
  // identifier. `param.name.getEnd()` is the binding-name end and
  // should be invariant to the decorator's leading trivia. If apply
  // mislands due to the decorator, the output will fail to parse or
  // attach the annotation at the wrong slot.
  it("parameter decorator on method param produces parseable output", () => {
    const input = `
function inject(target: any, key: string | undefined, idx: number) {}
class Service {
    handle(@inject msg) {
        return msg;
    }
}
new Service().handle('hi');`;
    const result = runPipeline(input)!;
    expectParseable(result);
    // The msg param's annotation must land between `msg` and the
    // closing `)` — not inside or before the decorator.
    expect(result).toMatch(/@inject msg:\s*string/);
  });

  // Dynamic-import expression coexisting with annotated sites in the
  // same file. The bug-class concern: `import(...)` is a
  // CallExpression whose callee is the `import` keyword (a reserved
  // word), not an Identifier — could confuse the transformer's
  // CallExpression handling, or the offset calculations for unrelated
  // annotation sites in the same source. Probe: a class method that
  // contains `import("./mod")` syntax plus a separately-observed
  // function in the same file. The import is in dead code so the vm
  // runtime doesn't try to resolve a non-existent module; what
  // matters for the AST-position concern is that the SYNTAX exists
  // in the source the transformer parses.
  it("dynamic-import in same file does not shift unrelated annotation offsets", () => {
    const input = `
function tag(s) {
    return 'tag:' + s;
}
class Loader {
    load(name) {
        // dead code — import() expression present but never evaluated
        // so vm runtime stays happy without a module resolver.
        if (false) {
            return import("./mod").then((m) => new m.Cls(name));
        }
        return name;
    }
}
tag('a');
new Loader().load('b');`;
    const result = runPipeline(input)!;
    expectParseable(result);
    expect(result).toMatch(/function tag\(s:\s*string\)/);
    expect(result).toMatch(/load\(name:\s*string\)/);
  });
});

// TSX-specific variant of expectParseable: parses with ScriptKind.TSX
// so JSX in the output is accepted.
function expectParseableTsx(source: string): void {
  const sf = ts.createSourceFile(
    "check.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  const errors = (diags ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const messages = errors
      .map((d) => `  - ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`)
      .join("\n");
    throw new Error(
      `Apply output failed to parse as TSX:\n${messages}\n\n--- source ---\n${source}\n--------------`,
    );
  }
}

// Extend the AST-position probe sweep to JSX-specific positions.
// ts-capture's transformer accepts .tsx; the unknown is whether the
// offset-based applier lands at the right byte for JSX-only shapes
// (paren-less arrows inside JSX expression containers, TSX type-param
// disambiguators, fragments, etc.). Confirm-or-deny probes — each one
// fails loudly if apply produces unparseable TSX.
//
// Some shapes (handler arrows in JSX attribute values, e.g.
// `<button onClick={e => …} />`) need a real DOM event loop to fire
// the callback; those are covered by the bench/demo-tsx harness, not
// here. This describe scopes to shapes invocable from a component
// function call.
describe("integration: AST-position bug class probes — JSX shapes", () => {
  it("function component with destructured props: apply lands at `}` of pattern", () => {
    const input = `
function Card({ title, body }) {
    return <article><h3>{title}</h3>{body}</article>;
}
Card({ title: 'a', body: 'b' });`;
    const result = runPipelineTsx(input)!;
    expectParseableTsx(result);
    expect(result).toContain("{ title, body }:");
  });

  it("arrow-style function component with destructured props", () => {
    const input = `
const Card = ({ title, body }) => <article><h3>{title}</h3>{body}</article>;
Card({ title: 'a', body: 'b' });`;
    const result = runPipelineTsx(input)!;
    expectParseableTsx(result);
    expect(result).toContain("{ title, body }:");
  });

  it("paren-less arrow inside JSX expression container: items.map(item => <li/>)", () => {
    // The map callback runs during component-function execution, so
    // `item` gets a real observation. Apply must wrap the paren-less
    // single param AND keep the JSX expression around it parseable.
    const input = `
function List({ items }) {
    return <ul>{items.map(item => <li>{item}</li>)}</ul>;
}
List({ items: [1, 2, 3] });`;
    const result = runPipelineTsx(input)!;
    expectParseableTsx(result);
    // Matches `(item: number) =>` (param wrap only) or
    // `(item: number): T =>` (param + return type) — both valid TSX.
    // Same shape as the existing paren-less arrow probe.
    expect(result).toMatch(/\(item:\s*number\)\s*(?::[^=]+)?=>/);
  });

  it("fragment shorthand wrapping instrumented JSX", () => {
    // `<>…</>` is TSX-only syntax — apply must not stumble parsing it
    // while threading offsets through the surrounding decl.
    const input = `
function Wrap({ children }) {
    return <>{children}</>;
}
Wrap({ children: 'x' });`;
    const result = runPipelineTsx(input)!;
    expectParseableTsx(result);
    expect(result).toContain("{ children }:");
  });

  it("function component with rest props in destructure", () => {
    const input = `
function Foo({ a, ...rest }) {
    return <div>{String(a)}{JSON.stringify(rest)}</div>;
}
Foo({ a: 1, b: 2, c: 3 });`;
    const result = runPipelineTsx(input)!;
    expectParseableTsx(result);
    expect(result).toContain("{ a, ...rest }:");
  });

  it("TSX type-param disambiguator `<T,>(x) => x` does not break apply parser", () => {
    // The trailing comma in `<T,>` is TSX's way to disambiguate from
    // a JSX opening tag. apply-types.ts currently parses with
    // ScriptKind.TS internally — this probe surfaces whether that's
    // a problem in practice (it may parse fine even as TS since the
    // comma form is a generic-only construct).
    const input = `
const id = <T,>(x) => x;
id<number>(42);
id<string>('hi');`;
    const result = runPipelineTsx(input)!;
    expectParseableTsx(result);
    expect(result).toMatch(/<T,>\(x:/);
  });

  it("generic component invocation `<Foo<string> v=... />` does not break apply parser", () => {
    // TSX-specific: type arguments on a JSX component. The probe
    // checks that the surrounding decl's apply offsets aren't
    // corrupted by apply-time TS-vs-TSX parsing ambiguity.
    const input = `
function Foo(p) { return <span>{String(p.v)}</span>; }
const el = <Foo<string> v="x" />;
Foo({ v: 'x' });
void el;`;
    const result = runPipelineTsx(input)!;
    expectParseableTsx(result);
    expect(result).toMatch(/function Foo\(p:/);
  });
});

// Most-specific-common-base collapse, end-to-end through the
// full pipeline. Runtime captures the prototype chain inline with a
// `@sa:` marker; apply-time collapses observed class unions to the
// most-specific shared ancestor when `infer.rewriteCommonBase` is on.
describe("integration: RewriteMostSpecificCommonBase", () => {
  it("collapses Cat | Dog observed at one param to their common Mammal base", () => {
    const input = `
class Animal {}
class Mammal extends Animal {}
class Cat extends Mammal {}
class Dog extends Mammal {}
function describe(pet) { return pet; }
describe(new Cat());
describe(new Dog());`;
    const result = runPipeline(input, {
      collector: { captureClassHierarchy: true },
      apply: { infer: { ...INFER_DEFAULTS, rewriteCommonBase: true } },
    })!;
    expect(result).toContain("function describe(pet: Mammal)");
    // No leaked markers.
    expect(result).not.toContain("@sa:");
  });

  it("with capture on but rewriteCommonBase off — keeps flat union, strips markers", () => {
    const input = `
class Animal {}
class Mammal extends Animal {}
class Cat extends Mammal {}
class Dog extends Mammal {}
function describe(pet) { return pet; }
describe(new Cat());
describe(new Dog());`;
    const result = runPipeline(input, {
      collector: { captureClassHierarchy: true },
      // apply uses defaults — rewriteCommonBase=false
    })!;
    expect(result).toMatch(/pet:\s*Cat\|Dog/);
    expect(result).not.toContain("@sa:");
  });

  it("with capture off — observations don't carry chain, behaviour identical to today", () => {
    const input = `
class Animal {}
class Mammal extends Animal {}
class Cat extends Mammal {}
class Dog extends Mammal {}
function describe(pet) { return pet; }
describe(new Cat());
describe(new Dog());`;
    // Both sides default — no change in behaviour expected.
    const result = runPipeline(input)!;
    expect(result).toMatch(/pet:\s*Cat\|Dog/);
    expect(result).not.toContain("@sa:");
  });

  it("collapses sibling subtrees (Cat extends Mammal, Sparrow extends Bird) to Animal", () => {
    const input = `
class Animal {}
class Mammal extends Animal {}
class Bird extends Animal {}
class Cat extends Mammal {}
class Sparrow extends Bird {}
function watch(creature) { return creature; }
watch(new Cat());
watch(new Sparrow());`;
    const result = runPipeline(input, {
      collector: { captureClassHierarchy: true },
      apply: { infer: { ...INFER_DEFAULTS, rewriteCommonBase: true } },
    })!;
    expect(result).toContain("function watch(creature: Animal)");
    expect(result).not.toContain("@sa:");
  });

  it("keeps unrelated hierarchies as a flat union (no shared ancestor)", () => {
    const input = `
class Animal {}
class Cat extends Animal {}
class Plant {}
class Daisy extends Plant {}
function inspect(thing) { return thing; }
inspect(new Cat());
inspect(new Daisy());`;
    const result = runPipeline(input, {
      collector: { captureClassHierarchy: true },
      apply: { infer: { ...INFER_DEFAULTS, rewriteCommonBase: true } },
    })!;
    expect(result).toMatch(/thing:\s*Cat\|Daisy/);
    expect(result).not.toContain("@sa:");
  });

  it("primitives mixed with class observations stay in the union, classes still collapse", () => {
    const input = `
class Animal {}
class Cat extends Animal {}
class Dog extends Animal {}
function tag(x) { return x; }
tag(new Cat());
tag(new Dog());
tag("plain string");`;
    const result = runPipeline(input, {
      collector: { captureClassHierarchy: true },
      apply: { infer: { ...INFER_DEFAULTS, rewriteCommonBase: true } },
    })!;
    expect(result).toMatch(/x:\s*Animal\|string/);
    expect(result).not.toContain("@sa:");
  });
});

// Skip annotations TS would already infer from the initializer.
// End-to-end via the full pipeline: a `let count = 0` observation
// should produce a redundant `: number` annotation by default, but
// get suppressed when `infer.skipInferableVarDecls` is on.
describe("integration: skipInferableVarDecls", () => {
  it("OFF (default): `let count = 0` still gets redundant `: number`", () => {
    const input = `
let count = 0;
function use(a) { return a; }
use(count);`;
    const result = runPipeline(input)!;
    // varDecl observation fires for count; default behaviour annotates.
    expect(result).toContain("let count: number = 0");
  });

  it("ON: `let count = 0` skips redundant `: number`", () => {
    const input = `
let count = 0;
function use(a) { return a; }
use(count);`;
    const result = runPipeline(input, {
      apply: { infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true } },
    })!;
    expect(result).not.toContain("let count: number");
    expect(result).toContain("let count = 0");
  });

  it("ON: `const x = new Cat()` skips matching annotation but param `a` still gets typed", () => {
    const input = `
class Cat {}
const c = new Cat();
function use(a) { return a; }
use(c);`;
    const result = runPipeline(input, {
      apply: { infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true } },
    })!;
    expect(result).not.toContain("const c: Cat");
    expect(result).toContain("const c = new Cat()");
    // Function params are out of scope for the inferable check.
    expect(result).toContain("function use(a: Cat)");
  });

  it("ON: `const x = JSON.parse(...)` (call expression) keeps annotation", () => {
    // We don't suppress for call expressions — TS would infer `any`
    // from JSON.parse, so ts-capture's observed structure is more useful.
    const input = `
const obj = JSON.parse('{"id":1}');
function use(a) { return a; }
use(obj);`;
    const result = runPipeline(input, {
      apply: { infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true } },
    })!;
    expect(result).toMatch(/const obj:\s*\{ id: number \}\s*=/);
  });
});

// Cross-validation sweep for the CST-aware applier. Re-runs a curated
// set of scenarios from the suites above with `infer.cstAware: true`
// and asserts byte-equivalence with the default offset-based path.
// This is the "no regressions on the integration fixture" check.
// Any case where CST is intentionally MORE capable than the
// offset-based path (paren-less arrow return types, thisType without
// the thisNeedsComma flag) belongs in apply-types-cst.spec.ts as a
// CST-only assertion, not here.
describe("integration: cstAware parity with offset-based applier", () => {
  function bothAgree(input: string, applyOpts: ApplyTypesOptions = {}): string {
    const offsetResult = runPipeline(input, { apply: applyOpts });
    const cstResult = runPipeline(input, {
      apply: { ...applyOpts, infer: { ...INFER_DEFAULTS, ...applyOpts.infer, cstAware: true } },
    });
    expect(cstResult).toBe(offsetResult);
    if (cstResult === null) throw new Error("pipeline produced no output");
    return cstResult;
  }

  it("simple param annotation", () => {
    const result = bothAgree(`
function greet(c) {
    return 'Hello ' + c;
}
greet('World');`);
    expect(result).toContain("function greet(c: string): string");
  });

  it("union type from multiple call sites", () => {
    const result = bothAgree(`
function commas(item) {
    return Array.from(item).join(', ');
}
commas('Lavender');
commas(['Apples', 'Oranges']);`);
    expect(result).toContain("item: string|string[]");
  });

  it("optional parameter", () => {
    bothAgree(`
function calculate(a, b?) {
    return a + (b || 0);
}
calculate(5, 6);`);
  });

  it("destructured parameter with default", () => {
    bothAgree(`
function greet({ who = "" }) {
    return 'Hello, ' + who;
}
greet({who: 'world'});`);
  });

  it("nested arrow functions", () => {
    bothAgree(`
function doTheThing(cb) {
    cb([1,2,3]);
}
doTheThing((results) => {
    results.forEach((result) => console.log(result));
});`);
  });

  it("class methods with multiple call sites", () => {
    bothAgree(`
class Greeter {
    greet(who) {
        return 'Hello, ' + who;
    }
}
new Greeter().greet('World');`);
  });

  it("variable declaration inference", () => {
    bothAgree(`let x = 5;\nfunction use(a) { return a; }\nuse(x);`);
  });

  it("class property inference via constructor-param synthesis", () => {
    bothAgree(`
class Foo {
    value = 42;
    greet() { return this.value; }
}
new Foo().greet();`);
  });

  it("async function with Promise return wrap", () => {
    bothAgree(`
async function fetchData(url) { return url.length; }
fetchData("http://example.com");`);
  });

  it("function cross-referencing (callback type from registered fn)", () => {
    bothAgree(`
function process(cb) {
    cb(42);
}
function double(x) { return x * 2; }
process(double);`);
  });

  it("RewriteMostSpecificCommonBase + cstAware combined", () => {
    bothAgree(
      `
class Animal {}
class Mammal extends Animal {}
class Cat extends Mammal {}
class Dog extends Mammal {}
function describe(pet) { return pet; }
describe(new Cat());
describe(new Dog());`,
      { infer: { ...INFER_DEFAULTS, rewriteCommonBase: true } },
    );
  });

  it("skipInferableVarDecls + cstAware combined", () => {
    bothAgree(
      `
let count = 0;
function use(a) { return a; }
use(count);`,
      { infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true } },
    );
  });

  it("function-expression outer-annotation guard: const fn = (x) => ... — outer skip on both paths", () => {
    bothAgree(`
const fn = (x) => x + 1;
fn(5);`);
  });

  // Paren-less arrow wrapping is asserted at the unit level in
  // apply-types-cst.spec.ts. The integration pipeline always
  // instruments return types; for paren-less arrows, CST applies the
  // return annotation while the offset path skips it
  // (positionLooksLikeInsertionSite requires `before === ")"`). That
  // divergence is intentional, not a parity violation, and a parity
  // assertion here would always fail.
});
