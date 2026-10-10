import { describe, expect, it } from "vitest";

import { collect } from "./collected.js";
import { inspected, instrumented } from "./instrumented.js";
import "./matchers.js";
import { stripInstrumentation } from "./strip-instrumentation.js";

// What every converted instrumenter spec will stand on, so each matcher and
// each invariant is proved both ways: it accepts what it should and names
// what it rejects.

const EVERY_FORM = `function inc(a, { b, c }, d?) { return a + b; }
const f = x => x + 1;
const g = async (y) => { return y; };
class K { n = inc(1, { b: 2, c: 3 }); m(cb) { return cb(this.n); } }
let { p, q } = { p: 1, q: "s" };
[1].map((v) => v * 2);
inc(1, { b: 2, c: 3 }); f(2); g(3); new K().m((z) => z);
`;
const TRACK_ARGUMENTS = { options: { instrumentCallExpressions: true } };

const handWritten = (call: string): string => `function foo(a) { ${call}; return a; }`;

describe("instrumented", () => {
  it("decodes a call of each of the five forms", () => {
    const out = instrumented(EVERY_FORM, TRACK_ARGUMENTS);
    const forms = new Set(out.calls.map((call) => call.form));
    expect([...forms].sort()).toEqual(["param", "regFn", "registerFn", "ret", "track"]);
  });

  it("reads the name, offset, file and options of a parameter call", () => {
    const out = instrumented("const f = x => x + 1;");
    const [call] = out.calls.filter((c) => c.form === "param");
    expect(call).toMatchObject({
      name: "x",
      pos: 11,
      filename: "test.ts",
      options: { arrow: true, parens: [10, 11] },
      valueText: "x",
    });
  });

  it("reads the wrapped expression of a ret, a track and a regFn call", () => {
    const out = instrumented("let n = inc(k);", TRACK_ARGUMENTS);
    const byForm = Object.fromEntries(out.calls.map((c) => [c.form, c.valueText]));
    expect(byForm).toMatchObject({ track: "k" });
    expect(byForm.ret).toMatch(/^inc\(/);
  });

  it("holds an output produced elsewhere against its input", () => {
    const src = "function foo(a) { return a; }";
    const out = inspected(instrumented(src).text, { input: src });
    expect(out).toTrack("a");
  });
});

describe("the invariants of instrumented()", () => {
  it("rejects a parameter call whose offset is not the end of its name", () => {
    const src = "function foo(a) { return a; }";
    const moved = handWritten('__tscptr__("a", a, 3, "test.ts", "{}")');
    expect(() => inspected(moved, { input: src })).toThrow(/"a".*offset 3.*no parameter/s);
  });

  it("rejects a parameter call that names another parameter than the one at its offset", () => {
    const src = "function foo(a) { return a; }";
    const renamed = handWritten('__tscptr__("b", b, 14, "test.ts", "{}")');
    expect(() => inspected(renamed, { input: src })).toThrow(/"b".*offset 14.*a/s);
  });

  it("rejects an output that does not parse", () => {
    expect(() => inspected("function foo(a) { return a; ")).toThrow(/does not parse.*TS1005/s);
  });

  it("rejects a call it cannot decode", () => {
    const computed = handWritten('__tscptr__("a", a, where, "test.ts", "{}")');
    expect(() => inspected(computed)).toThrow(/cannot decode.*where/s);
  });

  it("rejects an output that is more than its input plus the calls", () => {
    const src = "function foo(a) { return a; }";
    const edited = instrumented(src).text.replace("function foo", "function bar");
    expect(() => inspected(edited, { input: src, additive: true })).toThrow(
      /changed more than it added.*function bar \(/s,
    );
  });

  it("lets a fixture opt out of an invariant by name", () => {
    const src = "function foo(a) { return a; }";
    const moved = handWritten('__tscptr__("a", a, 3, "test.ts", "{}")');
    expect(() => inspected(moved, { input: src, allow: { positions: true } })).not.toThrow();
  });
});

describe("stripInstrumentation", () => {
  it("gives the input back from an output with every form", () => {
    const out = instrumented(EVERY_FORM, TRACK_ARGUMENTS);
    expect(stripInstrumentation(out.text)).toBe(stripInstrumentation(EVERY_FORM));
    expect(stripInstrumentation(out.text)).not.toContain("__tscptr__");
  });

  it("unwraps a call in expression position and removes one that is a statement", () => {
    const stripped = stripInstrumentation(
      'function foo(a) { __tscptr__("a", a, 14, "t.ts", "{}"); a = __tscptr__.ret(b, 1, "t.ts", "{}"); }',
    );
    expect(stripped).toBe(stripInstrumentation("function foo(a) { a = b; }"));
  });

  it("unwraps nested calls from the inside out", () => {
    const stripped = stripInstrumentation(
      'const f = __tscptr__.ret(__tscptr__.regFn(x => (__tscptr__("x", x, 11, "t.ts", "{}"), __tscptr__.ret(x + 1, 11, "t.ts", "{}")), 11, "t.ts"), 7, "t.ts", "{}");',
    );
    expect(stripped).toBe(stripInstrumentation("const f = x => x + 1;"));
  });

  it("keeps the parentheses the input had around an arrow's body", () => {
    const src = "const f = (x) => ({ x });";
    expect(stripInstrumentation(instrumented(src).text)).toBe(stripInstrumentation(src));
  });

  it("removes the parentheses put around an arrow body with nothing in front of it", () => {
    const src = "const one = () => 1;\nconst called = ((x) => x)(2);";
    expect(stripInstrumentation(instrumented(src).text)).toBe(stripInstrumentation(src));
  });

  it("compares programs, not layouts", () => {
    const src = "class Greeter {\n  greet(who) {\n    return 'Hello, ' + who; // loudly\n  }\n}\n";
    expect(stripInstrumentation(instrumented(src).text)).toBe(
      stripInstrumentation("class Greeter { greet(who) { return 'Hello, ' + who } }"),
    );
  });

  it("removes the runtime declarations", () => {
    const out = instrumented("const x = 1;");
    expect(out.text).toContain("declare namespace __tscptr__");
    expect(stripInstrumentation(out.text)).toBe(stripInstrumentation("const x = 1;"));
  });
});

describe("toTrack", () => {
  it("finds a parameter by name", () => {
    expect(instrumented("function foo(a, b) { return a; }")).toTrack("b");
  });

  it("matches the options as a subset, whatever order the JSON has them in", () => {
    const text = handWritten(
      '__tscptr__("a", a, 14, "test.ts", "{\\"arrow\\":true,\\"parens\\":[1,2]}")',
    );
    const out = inspected(text);
    expect(out).toTrack("a", { parens: [1, 2], arrow: true });
    expect(out).toTrack("a", { arrow: true });
    expect(() => expect(out).toTrack("a", { parens: [1, 3] })).toThrow(/parens.*\[1,2\]/s);
  });

  it("matches the file the call names", () => {
    const out = instrumented("function foo(a) { return a; }", { filename: "src/my-file.ts" });
    expect(out).toTrack("a", { in: "src/my-file.ts" });
    expect(() => expect(out).toTrack("a", { in: "other.ts" })).toThrow(/src\/my-file\.ts/);
  });

  it("says what is tracked when the name is not", () => {
    const out = instrumented("function foo(a: string, b) { return a; }");
    expect(() => expect(out).toTrack("a")).toThrow(
      /expected a to be tracked, but no __tscptr__ call records it.*b/s,
    );
  });
});

describe("toLeaveUntracked", () => {
  it("accepts a typed parameter and rejects an untyped one, quoting the call", () => {
    const out = instrumented("function foo(a: string, b) { return a; }");
    expect(out).toLeaveUntracked("a");
    expect(() => expect(out).toLeaveUntracked("b")).toThrow(
      /expected b to be left untracked, but __tscptr__\("b", b, 25, .* records it/s,
    );
  });

  it("sees a call that records the name's position without naming it", () => {
    const out = instrumented("let x = 1;");
    expect(() => expect(out).toLeaveUntracked("x")).toThrow(/__tscptr__\.ret\(1, 5,/);
  });
});

describe("toWrapReturnOf, toWrapInitializerOf and toTrackArgument", () => {
  it("finds the return of a function by the function's name", () => {
    const out = instrumented("function inc(a) { return a + 1; }\nconst twice = (b) => b * 2;");
    expect(out).toWrapReturnOf("inc");
    expect(out).toWrapReturnOf("twice");
    expect(() => expect(out).toWrapReturnOf("thrice")).toThrow(/inc, twice/);
  });

  it("does not take an inner function's return for the outer one's", () => {
    const out = instrumented("function* outer() { const inner = () => 1; yield inner; }");
    expect(out).toWrapReturnOf("inner");
    expect(out).not.toWrapReturnOf("outer");
  });

  it("matches the options of the return", () => {
    const out = instrumented("async function load() { return 1; }");
    expect(out).toWrapReturnOf("load", { async: true });
  });

  it("finds an initializer by the declared name, and quotes it when it should be bare", () => {
    const out = instrumented("let x = myFn(1);\nclass C { y = 2; }\nlet z: number = 3;");
    expect(out).toWrapInitializerOf("x");
    expect(out).toWrapInitializerOf("y");
    expect(out).not.toWrapInitializerOf("z");
    expect(() => expect(out).not.toWrapInitializerOf("x")).toThrow(/__tscptr__\.ret\(myFn\(1\)/);
  });

  it("finds a tracked argument by its text", () => {
    const out = instrumented("foo(bar)", TRACK_ARGUMENTS);
    expect(out).toTrackArgument("bar");
    expect(() => expect(out).toTrackArgument("baz")).toThrow(/bar/);
    expect(instrumented("foo(bar)")).not.toTrackArgument("bar");
  });
});

describe("toDeclareRuntime and toLeaveUnchanged", () => {
  it("sees the declarations, and their absence", () => {
    const src = "function foo(a) { return a; }";
    expect(instrumented(src)).toDeclareRuntime();
    expect(instrumented(src, { options: { skipTscptrDeclarations: true } })).not.toDeclareRuntime();
  });

  it("accepts an output with no calls and the input's program", () => {
    const options = { skipTscptrDeclarations: true };
    expect(instrumented("declare function foo(a: number): void;", { options })).toLeaveUnchanged();
    expect(() =>
      expect(instrumented("function foo(a) { return a; }", { options })).toLeaveUnchanged(),
    ).toThrow(/__tscptr__\.registerFn\(foo, 15/);
  });
});

describe("run and toObserve", () => {
  it("collects what the sandbox collector collects", () => {
    const out = instrumented(EVERY_FORM, TRACK_ARGUMENTS);
    expect(out.run().entries).toEqual(collect(EVERY_FORM));
  });

  it("observes a parameter and a return by name", () => {
    const observed = instrumented("function inc(a) { return String(a); }\ninc(1);").run();
    expect(observed).toObserve("a", "number");
    expect(observed).toObserve({ returnOf: "inc" }, "string");
    expect(() => expect(observed).toObserve("a", "string")).toThrow(/observed number/);
  });

  it("calls what the fixture declares, with the values given", () => {
    const observed = instrumented("const pair = (a, b) => [a, b];").run({ pair: [1, "x"] });
    expect(observed).toObserve("a", "number");
    expect(observed).toObserve("b", "string");
  });

  it("observes every type a site saw, as one union", () => {
    const observed = instrumented("function id(a) { return a; }\nid(1); id('x');").run();
    expect(observed).toObserve("a", "string | number");
  });

  it("says so when nothing was observed at the site", () => {
    const observed = instrumented("function id(a) { return a; }").run();
    expect(() => expect(observed).toObserve("a", "number")).toThrow(/nothing was observed at a/);
  });
});
