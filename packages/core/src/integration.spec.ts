import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { InferOptions } from "./configuration.js";

import { INFER_DEFAULTS } from "./configuration.js";
import { type Applied, applied, nodesOf, parseErrors, printedAst } from "./test-utils/applied.js";
import { collect, type CollectOptions } from "./test-utils/collected.js";
import { describeDiagnostic } from "./test-utils/matchers.js";

interface PipelineOptions extends CollectOptions {
  infer?: InferOptions;
  applier?: "cst" | "offset";
  prefix?: string;
  /** What this output may do that a pipeline output otherwise may not. */
  allow?: { newDiagnostics?: boolean; applierDivergence?: boolean; secondRunChange?: boolean };
}

/**
 * The whole pipeline on one file, and on the way out what every output must
 * satisfy: it parses, it adds no diagnostic the input did not have, the CST
 * and offset appliers wrote the same program, and running the pipeline on
 * the output again changes nothing.
 */
function pipeline(input: string, options: PipelineOptions = {}): Applied {
  const entries = collect(input, options);
  if (entries.length === 0) throw new Error(`nothing observed in:\n${input}`);
  const filename = options.tsx ? "test.tsx" : "test.ts";
  const { infer, applier, prefix, allow } = options;
  const out = applied(input, entries, { infer, applier, prefix, filename });

  expect(parseErrors(out), `the output does not parse:\n${out.text}`).toEqual([]);
  if (!allow?.newDiagnostics) {
    expect(out.newDiagnostics.map(describeDiagnostic), `new diagnostics in:\n${out.text}`).toEqual(
      [],
    );
  }
  if (!allow?.applierDivergence) {
    const otherApplier = applier === "offset" ? "cst" : "offset";
    const other = applied(input, entries, { infer, prefix, filename, applier: otherApplier });
    expect(printedAst(other.text), "the CST and offset appliers disagree").toBe(
      printedAst(out.text),
    );
  }
  if (!allow?.secondRunChange) {
    const again = applied(out.text, collect(out.text, options), {
      infer,
      applier,
      prefix,
      filename,
    });
    expect(again.text, "a second run of the pipeline changed the output").toBe(out.text);
  }
  return out;
}

const withInfer = (patch: Partial<InferOptions>): PipelineOptions => ({
  infer: { ...INFER_DEFAULTS, ...patch },
});
const KEEP_INFERABLE = withInfer({ skipRedundantAnnotations: false });

describe("integration: full pipeline", () => {
  it("infers string type for a simple function", () => {
    const out = pipeline(`
function greet(c) {
    return 'Hello ' + c;
}
greet('World');`);
    expect(out).toTypeAs("c", "string");
    expect(out).toTypeAs({ returnOf: "greet" }, "string");
  });

  it("infers number type for arrow function", () => {
    const out = pipeline(`((x) => { return x + 5; })(10)`);
    expect(out).toTypeAs("x", "number");
    const [arrow] = nodesOf(out, ts.isArrowFunction);
    expect(out.checker.typeToString(out.checker.getTypeAtLocation(arrow))).toBe(
      "(x: number) => number",
    );
  });

  it("infers types for class methods", () => {
    const out = pipeline(`
class Greeter {
    greet(who) {
        return 'Hello, ' + who;
    }
}
new Greeter().greet('World');`);
    expect(out).toTypeAs("who", "string");
    expect(out).toTypeAs({ returnOf: "greet" }, "string");
  });

  it("creates union types from multiple calls", () => {
    const out = pipeline(`
function commas(item) {
    return Array.from(item).join(', ');
}
commas('Lavender');
commas(['Apples', 'Oranges']);`);
    expect(out).toTypeAs("item", "string | string[]");
  });

  it("handles optional parameters", () => {
    const out = pipeline(`
function calculate(a, b?) {
    return a + (b || 0);
}
calculate(5, 6);`);
    expect(out).toTypeAs("a", "number");
    expect(out).toTypeAs("b", "number | undefined");
  });

  it("does not append undefined to optional params", () => {
    const out = pipeline(`
function optional(b?, c?) {
    return b || 0;
}
optional() + optional(10);`);
    expect(out).toAnnotate("b", "number");
    expect(out).toLeaveUntyped("c");
  });

  it("observes nothing for unused functions", () => {
    expect(
      collect(`
function unused(foo, bar) {
}`),
    ).toEqual([]);
  });

  it("infers object types", () => {
    const out = pipeline(`
function foo(obj) { return obj; }
foo({hello: 'world'});`);
    expect(out).toTypeAs("obj", "{ hello: string }");
  });

  it("handles nested arrow functions", () => {
    // `cb` is written `(results: unknown) => undefined`: the arrow has a block
    // body without `return`, so nothing is observed for its return, the
    // cross-ref never upgrades the receiver, and TypeScript rejects the call.
    const out = pipeline(
      `
function doTheThing(cb) {
    cb([1,2,3]);
}
doTheThing((results) => {
    results.forEach((result) => console.log(result));
});`,
      { allow: { newDiagnostics: true } },
    );
    expect(out).not.toLeaveUntyped("cb");
    expect(out).toTypeAs("results", "number[]");
    expect(out).toTypeAs("result", "number");
  });

  it("handles destructured parameters with defaults", () => {
    const out = pipeline(`
function greet({ who = "" }) {
    return 'Hello, ' + who;
}
greet({who: 'world'});`);
    expect(out).toTypeAs('{ who = "" }', "{ who: string }");
  });
});

describe("integration: return type inference", () => {
  it("infers return type for simple function", () => {
    const out = pipeline(`function double(x) { return x * 2; }\ndouble(5);`);
    expect(out).toTypeAs({ returnOf: "double" }, "number");
  });

  it("infers return type for arrow expression body", () => {
    const out = pipeline(`const fn = (x) => x + 1;\nfn(5);`);
    expect(out).toTypeAs({ returnOf: "fn" }, "number");
  });

  it("infers async return type wrapped in Promise", () => {
    const out = pipeline(
      `async function fetchData(url) { return url.length; }\nfetchData("http://example.com");`,
    );
    expect(out).toTypeAs({ returnOf: "fetchData" }, "Promise<number>");
  });

  it("infers union return type from multiple code paths", () => {
    const out = pipeline(
      `function maybe(x) { if (x > 0) return x; return "negative"; }\nmaybe(5);\nmaybe(-1);`,
    );
    expect(out).toTypeAs({ returnOf: "maybe" }, "number | string");
  });

  it("does not annotate return type for functions with existing return type", () => {
    const out = pipeline(`function typed(x): string { return x; }\ntyped("hello");`);
    expect(out).toAnnotate("x", "string");
    expect(out).toAnnotate({ returnOf: "typed" }, "string");
  });

  it("infers return type for class methods", () => {
    const out = pipeline(`
class Calculator {
    add(a, b) { return a + b; }
}
new Calculator().add(1, 2);`);
    expect(out).toTypeAs({ returnOf: "add" }, "number");
  });
});

describe("integration: function cross-referencing", () => {
  it("infers specific callback type from collected parameter observations", () => {
    const out = pipeline(`
function process(cb) {
    cb(42);
}
function double(x) { return x * 2; }
process(double);`);
    expect(out).toTypeAs("cb", "(x: number) => number");
  });

  it("infers full signature for anonymous inline arrows passed as call args", () => {
    // Inline arrows have no name to register by, so the transformer wraps
    // each one in `__tscptr__.regFn(arrow, …)` at creation; the cross-ref
    // in `getCollectedTypes` then upgrades the receiver's param from
    // `(x: unknown) => unknown` to the observed signature.
    const out = pipeline(`
function apply(fn, val) {
    return fn(val);
}
apply((x) => x + 1, 5);`);
    expect(out).toTypeAs("fn", "(x: number) => number");
  });

  it("infers callback type for named function expressions", () => {
    const out = pipeline(`
function forEach(arr, callback) {
    for (const item of arr) callback(item);
}
function log(x) { return String(x); }
forEach([1, 2, 3], log);`);
    expect(out).toTypeAs("callback", "(x: number) => string");
  });

  it("emits `@ts-capture:generic-fn` marker for un-invoked callback values", () => {
    // `fn` is passed but never called inside `apply`, so its arrow body never
    // runs and nothing is observed for it: the emit stays
    // `(x: unknown) => unknown`, which the typed arrow does not fit, and the
    // marker fires. The marker is text. A second run owns every note and
    // writes back only those at sites it annotates, so this one goes.
    const out = pipeline(
      `
function apply(fn, val) { return val; }
apply((x) => x + 1, 5);`,
      {
        ...withInfer({ requireTypeRefInScope: false, emitDiagnosticComments: true }),
        allow: { newDiagnostics: true, secondRunChange: true },
      },
    );
    expect(out).toAnnotate("fn", "(x: unknown) => unknown");
    expect(out.text).toContain("/* @ts-capture:generic-fn */");
  });

  it("preserves generic function type when function is not instrumented", () => {
    const out = pipeline(`
function apply(fn) {
    return fn(5);
}
apply(Math.floor);`);
    expect(out).toTypeAs("fn", "Function");
  });

  it("upgrades object-member callback return type from unknown", () => {
    // A function-valued property inside a props object is registered via
    // regFn like any arrow; the cross-ref must reach it through the object.
    const out = pipeline(`
function render(props) {
  return props.render(props.value);
}
render({ render: (x) => x * 2, value: 5 });`);
    expect(out).toTypeAs("props", "{ render(x: number): number; value: number }");
  });

  it("upgrades multiple function members in the same object", () => {
    const out = pipeline(`
function run(ops) {
  ops.double(ops.triple(2));
}
run({ double: (x) => x * 2, triple: (x) => x * 3 });`);
    expect(out).toTypeAs("ops", "{ double(x: number): number; triple(x: number): number }");
  });

  it("upgrades callback return type via invocation-site observation when parent isn't registered", () => {
    // `helper.bind(null)` is a new function the registry never saw, so the
    // cross-ref misses. The transformer wraps the `cb(...)` call inside
    // callbacker with a paramReturn observation, and the observed `number`
    // replaces the trailing `unknown` of the bound function's shape. The
    // shape's `unknown[]` parameters are what `bind` erased, and TypeScript,
    // which keeps them, rejects the bound `(x: number) => number` for it.
    const out = pipeline(
      `
function callbacker(cb) {
    return cb(21);
}
function helper(x) { return x * 2; }
callbacker(helper.bind(null));`,
      { allow: { newDiagnostics: true } },
    );
    expect(out).toTypeAs("cb", "(...args: unknown[]) => number");
  });

  it("widens sole-undefined return to void in cross-ref-emitted callback signatures", () => {
    // The arrow returns undefined. Its own return annotation is widened to
    // `void`; the receiver's callback param must get the same widening, or
    // callers would hand a `=> void` to a `=> undefined`.
    const out = pipeline(`
function listen(handler) {
  handler(1);
}
listen((x) => console.log(x));`);
    expect(out).toTypeAs("handler", "(x: number) => void");
  });

  it("widens undefined → void inside object-shape callback members", () => {
    const out = pipeline(`
function dispatch(api) {
  api.send(42);
}
dispatch({ send: (x) => console.log(x) });`);
    expect(out).toTypeAs("api", "{ send(x: number): void }");
  });

  it("does not override a specific parent-supplied return type with paramReturn (fallback only)", () => {
    // `double` is registered with its full signature, and the paramReturn
    // observation for `cb(42)` must not replace it with a looser one.
    const out = pipeline(`
function process(cb) {
    cb(42);
}
function double(x) { return x * 2; }
process(double);`);
    expect(out).toTypeAs("cb", "(x: number) => number");
  });
});

// Whether an annotation was written is a question about the AST: TypeScript
// infers `number` for `let x = 5` with or without one.
describe("integration: variable and property inference", () => {
  it("infers type for let declaration", () => {
    const out = pipeline(`let x = 5;\nfunction use(a) { return a; }\nuse(x);`, KEEP_INFERABLE);
    expect(out).toAnnotate("x", "number");
  });

  it("infers type for const declaration", () => {
    const out = pipeline(
      `const label = "hello";\nfunction use(a) { return a; }\nuse(label);`,
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("label", "string");
  });

  it("infers type for class property", () => {
    const out = pipeline(
      `
class Foo {
    value = 42;
    greet() { return this.value; }
}
new Foo().greet();`,
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("value", "number");
  });

  it("does not annotate already-typed variables", () => {
    const out = pipeline(`let x: number = 5;\nfunction use(a) { return a; }\nuse(x);`);
    expect(out).toAnnotate("x", "number");
  });
});

describe("integration: edge cases from original", () => {
  it("infers object types with special keys", () => {
    const out = pipeline(
      "function foo(obj) { return obj; }\n" + "foo({hello: 'world', 'foo-bar': 42});",
    );
    expect(out).toTypeAs("obj", '{ "foo-bar": number; hello: string }');
  });

  it("does not crash on circular references", () => {
    const input = ["let a = {};", "a.a = a;", "function foo(obj) { return obj; }", "foo(a);"].join(
      "\n",
    );
    expect(() => pipeline(input)).not.toThrow();
  });

  it("applies prefix option", () => {
    // The prefix is text put in front of the type, so the text is the claim.
    const out = pipeline("function greet(c) { return 'Hello ' + c; }\ngreet('World');", {
      prefix: "/*auto*/",
    });
    expect(out.text).toContain("c: /*auto*/string");
  });
});

// An annotation dropped at the wrong position, inside a destructure pattern,
// between a decorator and its target, after a `?`, shows up as output that
// does not parse or a site TypeScript sees untyped. Each probe is one
// representative AST position; `pipeline` checks that the output parses.
describe("integration: AST-position bug class probes", () => {
  it("object destructure param: insertion at end of `}`", () => {
    const out = pipeline(`
function readUser({ name, age }) {
    return name + age;
}
readUser({ name: 'a', age: 1 });`);
    expect(out).toTypeAs("{ name, age }", "{ age: number; name: string }");
  });

  it("array destructure param: insertion at end of `]`", () => {
    const out = pipeline(`
function pair([a, b]) {
    return a + b;
}
pair([1, 2]);`);
    expect(out).toTypeAs("[a, b]", "number[]");
  });

  it("nested object destructure: insertion at end of outer `}`", () => {
    const out = pipeline(`
function deep({ outer: { inner } }) {
    return inner;
}
deep({ outer: { inner: 'x' } });`);
    expect(out).toTypeAs("{ outer: { inner } }", "{ outer: { inner: string } }");
  });

  it("rest inside object destructure", () => {
    const out = pipeline(`
function spread({ a, ...rest }) {
    return a;
}
spread({ a: 1, b: 2, c: 3 });`);
    expect(out).toTypeAs("{ a, ...rest }", "{ a: number; b: number; c: number }");
  });

  it("rest parameter: insertion at end of `args`, not before `...`", () => {
    const out = pipeline(`
function sum(...args) {
    return args.reduce((a, b) => a + b, 0);
}
sum(1, 2, 3);`);
    expect(out).toTypeAs("args", "number[]");
  });

  it("constructor parameter property (public x)", () => {
    const out = pipeline(`
class Point {
    constructor(public x, public y) {}
}
new Point(1, 2);`);
    expect(out).toTypeAs("x", "number");
    expect(out).toTypeAs("y", "number");
  });

  it("optional param `a?` inserts `?:` (questionToken offset handled)", () => {
    // param.name.getEnd() is before the `?`; the transformer adds one to the
    // offset so the annotation lands after it, as `a?: T` and not `a: T?`.
    const out = pipeline(`
function maybe(a?) {
    return a || 0;
}
maybe(); maybe(7);`);
    expect(out).toTypeAs("a", "number | undefined");
  });

  it("paren-less single-param arrow: insertion wraps parens correctly", () => {
    // `x => body` has no parens to put the type inside. The CST applier
    // wraps and also writes the return type; the offset applier wraps and
    // leaves the return alone, which is why the two are allowed to differ.
    const out = pipeline(
      `
const inc = x => x + 1;
inc(5);`,
      { allow: { applierDivergence: true } },
    );
    expect(out).toTypeAs("x", "number");
    expect(out).toTypeAs({ returnOf: "inc" }, "number");
  });

  it("class method with computed name", () => {
    const out = pipeline(`
const key = 'doStuff';
class C {
    [key](x) { return x; }
}
new C()[key](42);`);
    expect(out).toTypeAs("x", "number");
  });

  it("generator function parameter", () => {
    const out = pipeline(`
function* gen(x) {
    yield x;
}
const g = gen(1); g.next();`);
    expect(out).toTypeAs("x", "number");
  });

  it("async generator function parameter", () => {
    const out = pipeline(`
async function* agen(x) {
    yield x;
}
(async () => { const it = agen(1); await it.next(); })();`);
    expect(out).toTypeAs("x", "number");
  });

  it("object-literal method shorthand parameter", () => {
    const out = pipeline(`
const o = {
    foo(x) { return x * 2; },
};
o.foo(3);`);
    expect(out).toTypeAs("x", "number");
  });

  it("decorated class with method param", () => {
    const out = pipeline(`
function logged(target: any) { return target; }
@logged
class Box {
    set(x) { return x; }
}
new Box().set('hi');`);
    expect(out).toTypeAs("x", "string");
  });

  it("multi-line param list does not corrupt insertion offsets", () => {
    const out = pipeline(`
function multi(
    a,
    b,
    c
) {
    return a + b + c;
}
multi(1, 2, 3);`);
    expect(out).toTypeAs("a", "number");
    expect(out).toTypeAs("b", "number");
    expect(out).toTypeAs("c", "number");
  });

  it("trailing comma in param list does not break insertion", () => {
    const out = pipeline(`
function tail(
    a,
    b,
) {
    return a + b;
}
tail(1, 2);`);
    expect(out).toTypeAs("a", "number");
    expect(out).toTypeAs("b", "number");
  });

  it("parameter decorator on method param", () => {
    // TypeScript parses a parameter decorator without the flag set, so apply
    // sees a modifier-like node right before the identifier. The annotation
    // must land between `msg` and `)`, not inside or before the decorator.
    const out = pipeline(`
function inject(target: any, key: string | undefined, idx: number) {}
class Service {
    handle(@inject msg) {
        return msg;
    }
}
new Service().handle('hi');`);
    expect(out).toTypeAs("msg", "string");
    expect(out.text).toMatch(/@inject msg:/);
  });

  it("dynamic-import in same file does not shift unrelated annotation offsets", () => {
    // `import(...)` is a call whose callee is a keyword, not an identifier.
    // It sits in dead code so the sandbox never resolves a module, which also
    // means the runtime never saw that branch's Promise: the return written
    // from what ran is one TypeScript rejects.
    const out = pipeline(
      `
function tag(s) {
    return 'tag:' + s;
}
class Loader {
    load(name) {
        if (false) {
            return import("./mod").then((m) => new m.Cls(name));
        }
        return name;
    }
}
tag('a');
new Loader().load('b');`,
      { allow: { newDiagnostics: true } },
    );
    expect(out).toTypeAs("s", "string");
    expect(out).toTypeAs("name", "string");
  });
});

// Handler arrows in JSX attribute values need a DOM event loop to fire and
// are covered by the bench/demo-tsx harness, not here.
describe("integration: AST-position bug class probes — JSX shapes", () => {
  const TSX = { tsx: true };

  it("function component with destructured props: apply lands at `}` of pattern", () => {
    const out = pipeline(
      `
function Card({ title, body }) {
    return <article><h3>{title}</h3>{body}</article>;
}
Card({ title: 'a', body: 'b' });`,
      TSX,
    );
    expect(out).toTypeAs("{ title, body }", "{ body: string; title: string }");
  });

  it("arrow-style function component with destructured props", () => {
    const out = pipeline(
      `
const Card = ({ title, body }) => <article><h3>{title}</h3>{body}</article>;
Card({ title: 'a', body: 'b' });`,
      TSX,
    );
    expect(out).toTypeAs("{ title, body }", "{ body: string; title: string }");
  });

  it("paren-less arrow inside JSX expression container: items.map(item => <li/>)", () => {
    // The map callback runs during the component call, so `item` is
    // observed. The appliers differ on the return type of a paren-less
    // arrow, as in the plain probe above.
    const out = pipeline(
      `
function List({ items }) {
    return <ul>{items.map(item => <li>{item}</li>)}</ul>;
}
List({ items: [1, 2, 3] });`,
      { ...TSX, allow: { applierDivergence: true } },
    );
    expect(out).toTypeAs("item", "number");
  });

  it("fragment shorthand wrapping instrumented JSX", () => {
    const out = pipeline(
      `
function Wrap({ children }) {
    return <>{children}</>;
}
Wrap({ children: 'x' });`,
      TSX,
    );
    expect(out).toTypeAs("{ children }", "{ children: string }");
  });

  it("function component with rest props in destructure", () => {
    const out = pipeline(
      `
function Foo({ a, ...rest }) {
    return <div>{String(a)}{JSON.stringify(rest)}</div>;
}
Foo({ a: 1, b: 2, c: 3 });`,
      TSX,
    );
    expect(out).toTypeAs("{ a, ...rest }", "{ a: number; b: number; c: number }");
  });

  it("TSX type-param disambiguator `<T,>(x) => x` does not break apply parser", () => {
    const out = pipeline(
      `
const id = <T,>(x) => x;
id<number>(42);
id<string>('hi');`,
      TSX,
    );
    expect(out).toTypeAs("x", "number | string");
  });

  it("generic component invocation `<Foo<string> v=... />` does not break apply parser", () => {
    const out = pipeline(
      `
function Foo(p) { return <span>{String(p.v)}</span>; }
const el = <Foo<string> v="x" />;
Foo({ v: 'x' });
void el;`,
      TSX,
    );
    expect(out).toTypeAs("p", "{ v: string }");
  });
});

// The runtime captures the prototype chain inline with a `@sa:` marker, and
// apply collapses observed class unions to the most specific shared ancestor
// when `infer.rewriteCommonBase` is on. The marker must never reach the file,
// and a marker inside a comment is not a parse error, so that stays text.
describe("integration: RewriteMostSpecificCommonBase", () => {
  const CAPTURE = { collector: { captureClassHierarchy: true } };
  const COLLAPSE = { ...CAPTURE, ...withInfer({ rewriteCommonBase: true }) };
  const PETS = `
class Animal {}
class Mammal extends Animal {}
class Cat extends Mammal {}
class Dog extends Mammal {}
function describe(pet) { return pet; }
describe(new Cat());
describe(new Dog());`;

  it("collapses Cat | Dog observed at one param to their common Mammal base", () => {
    const out = pipeline(PETS, COLLAPSE);
    expect(out).toAnnotate("pet", "Mammal");
    expect(out.text).not.toContain("@sa:");
  });

  it("with capture on but rewriteCommonBase off — keeps flat union, strips markers", () => {
    const out = pipeline(PETS, CAPTURE);
    expect(out).toAnnotate("pet", "Cat | Dog");
    expect(out.text).not.toContain("@sa:");
  });

  it("with capture off — observations don't carry chain, behaviour identical to today", () => {
    const out = pipeline(PETS);
    expect(out).toAnnotate("pet", "Cat | Dog");
    expect(out.text).not.toContain("@sa:");
  });

  it("collapses sibling subtrees (Cat extends Mammal, Sparrow extends Bird) to Animal", () => {
    const out = pipeline(
      `
class Animal {}
class Mammal extends Animal {}
class Bird extends Animal {}
class Cat extends Mammal {}
class Sparrow extends Bird {}
function watch(creature) { return creature; }
watch(new Cat());
watch(new Sparrow());`,
      COLLAPSE,
    );
    expect(out).toAnnotate("creature", "Animal");
    expect(out.text).not.toContain("@sa:");
  });

  it("keeps unrelated hierarchies as a flat union (no shared ancestor)", () => {
    const out = pipeline(
      `
class Animal {}
class Cat extends Animal {}
class Plant {}
class Daisy extends Plant {}
function inspect(thing) { return thing; }
inspect(new Cat());
inspect(new Daisy());`,
      COLLAPSE,
    );
    expect(out).toAnnotate("thing", "Cat | Daisy");
    expect(out.text).not.toContain("@sa:");
  });

  it("primitives mixed with class observations stay in the union, classes still collapse", () => {
    const out = pipeline(
      `
class Animal {}
class Cat extends Animal {}
class Dog extends Animal {}
function tag(x) { return x; }
tag(new Cat());
tag(new Dog());
tag("plain string");`,
      COLLAPSE,
    );
    expect(out).toAnnotate("x", "Animal | string");
    expect(out.text).not.toContain("@sa:");
  });
});

// Whether a redundant annotation was skipped is a question about the AST.
describe("integration: skipRedundantAnnotations", () => {
  const SKIP = withInfer({ skipRedundantAnnotations: true });
  const COUNT = `
let count = 0;
function use(a) { return a; }
use(count);`;

  it("OFF (explicit): `let count = 0` still gets redundant `: number`", () => {
    const out = pipeline(COUNT, KEEP_INFERABLE);
    expect(out).toAnnotate("count", "number");
  });

  it("ON: `let count = 0` skips redundant `: number`", () => {
    const out = pipeline(COUNT, SKIP);
    expect(out).toLeaveUntyped("count");
  });

  it("ON: `const x = new Cat()` skips matching annotation but param `a` still gets typed", () => {
    const out = pipeline(
      `
class Cat {}
const c = new Cat();
function use(a) { return a; }
use(c);`,
      SKIP,
    );
    expect(out).toLeaveUntyped("c");
    expect(out).toAnnotate("a", "Cat");
  });

  it("ON: `const x = JSON.parse(...)` (call expression) keeps annotation", () => {
    // TypeScript would infer `any` from JSON.parse, so the observed shape
    // says more and is kept.
    const out = pipeline(
      `
const obj = JSON.parse('{"id":1}');
function use(a) { return a; }
use(obj);`,
      SKIP,
    );
    expect(out).toAnnotate("obj", "{ id: number }");
  });
});
