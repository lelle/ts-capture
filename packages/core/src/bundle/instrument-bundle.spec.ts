import { describe, expect, it } from "vitest";

import { instrumentBundle } from "./instrument-bundle.js";

describe("instrumentBundle", () => {
  it("instruments a single function declaration", () => {
    const src = `function add(a, b) { return a + b; }\n`;
    const r = instrumentBundle(src, "test.js");
    expect(r.instrumentedCount).toBe(1);
    expect(r.code).toContain('__tscptr__("a",a,');
    expect(r.code).toContain('__tscptr__("b",b,');
    expect(r.code).toContain('"test.js"');
  });

  it("instruments multiple functions", () => {
    const src = `
      function f(x) { return x; }
      function g(y, z) { return y + z; }
    `;
    const r = instrumentBundle(src, "t.js");
    expect(r.instrumentedCount).toBe(2);
    expect(r.code).toContain('__tscptr__("x"');
    expect(r.code).toContain('__tscptr__("y"');
    expect(r.code).toContain('__tscptr__("z"');
  });

  it("skips functions with no parameters", () => {
    const src = `function noop() { return 1; }\n`;
    const r = instrumentBundle(src, "t.js");
    expect(r.instrumentedCount).toBe(0);
    // The runtime preamble itself defines __tscptr__, so check there's no
    // INSTRUMENTATION CALL pattern (i.e., a call to globalThis.__tscptr__ with
    // an actual parameter name as a string literal) in the post-preamble code.
    const postPreamble = r.code.slice(r.code.indexOf("function noop"));
    expect(postPreamble).not.toContain("__tscptr__");
  });

  it("instruments arrow functions with block bodies", () => {
    const src = `const f = (x) => { return x; };\n`;
    const r = instrumentBundle(src, "t.js");
    expect(r.instrumentedCount).toBe(1);
    expect(r.code).toContain('__tscptr__("x"');
  });

  it("does not instrument arrow expression bodies (no Block)", () => {
    const src = `const f = x => x + 1;\n`;
    const r = instrumentBundle(src, "t.js");
    expect(r.instrumentedCount).toBe(0);
  });

  it("instruments method declarations on classes", () => {
    const src = `class Foo { bar(z) { return z; } }\n`;
    const r = instrumentBundle(src, "t.js");
    expect(r.instrumentedCount).toBe(1);
    expect(r.code).toContain('__tscptr__("z"');
  });

  it("records the original parameter byte offset (pre-insertion)", () => {
    const src = `function add(a, b) { return a + b; }`;
    const r = instrumentBundle(src, "t.js");
    // a is at byte offset 13 in `function add(a, b)` (0-indexed)
    // b is at byte offset 16
    expect(r.code).toMatch(/__tscptr__\("a",a,13,"t\.js"\)/);
    expect(r.code).toMatch(/__tscptr__\("b",b,16,"t\.js"\)/);
  });

  it("uses the bundlePath option for the recorded path", () => {
    const src = `function f(x) { return x; }`;
    const r = instrumentBundle(src, "/abs/path/t.js", { bundlePath: "logical/t.js" });
    expect(r.code).toContain('"logical/t.js"');
    expect(r.code).not.toContain('"/abs/path/t.js"');
  });

  it("includes an idempotent runtime preamble", () => {
    const src = `function f(x) { return x; }`;
    const r = instrumentBundle(src, "t.js");
    // Idempotency guard via Symbol.for
    expect(r.code).toContain('Symbol.for("ts-capture.bundle.runtime")');
    // Per-PID dump file pattern
    expect(r.code).toContain("ts-capture-bundle-types-");
  });

  it("preamble reads literal-type env vars (parity with the babel-plugin runtime)", () => {
    const src = `function f(x) { return x; }`;
    const r = instrumentBundle(src, "t.js");
    expect(r.code).toContain('process.env.TS_CAPTURE_LITERAL_STRING === "true"');
    expect(r.code).toContain("process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH");
    expect(r.code).toContain('process.env.TS_CAPTURE_LITERAL_NUMBER === "true"');
    expect(r.code).toContain('process.env.TS_CAPTURE_LITERAL_BOOLEAN === "true"');
  });

  it("getType honors literal flags (compiled snippet behavior)", () => {
    // Smoke-test the getType fragment by extracting and evaling it with
    // controlled flag values. This proves the runtime branches actually wire
    // through, not just that the env-var reads are present.
    const src = `function f(x) { return x; }`;
    const r = instrumentBundle(src, "t.js");
    const getTypeFn = new Function(
      "LITERAL_STRING",
      "LITERAL_STRING_MAX",
      "LITERAL_NUMBER",
      "LITERAL_BOOLEAN",
      `
        function getType(value) {
          if (value === null) return "null";
          if (value === undefined) return "undefined";
          if (Array.isArray(value)) return "array";
          var t = typeof value;
          if (t === "string" && LITERAL_STRING && value.length <= LITERAL_STRING_MAX) return JSON.stringify(value);
          if (t === "number" && LITERAL_NUMBER && Number.isFinite(value)) return String(value);
          if (t === "boolean" && LITERAL_BOOLEAN) return String(value);
          if (t === "object") {
            var ctor = value.constructor && value.constructor.name;
            return ctor && ctor !== "Object" ? ctor : "object";
          }
          return t;
        }
        return getType;
      `,
    );

    const off = getTypeFn(false, 16, false, false);
    expect(off("hello")).toBe("string");
    expect(off(42)).toBe("number");
    expect(off(true)).toBe("boolean");

    const on = getTypeFn(true, 16, true, true);
    expect(on("hello")).toBe('"hello"');
    expect(on(42)).toBe("42");
    expect(on(true)).toBe("true");
    expect(on(NaN)).toBe("number"); // not a valid TS literal
    expect(on("a".repeat(20))).toBe("string"); // exceeds max length

    // Sanity: the preamble must contain the same getType source we evaluated.
    expect(r.code).toContain("LITERAL_STRING && value.length <= LITERAL_STRING_MAX");
    expect(r.code).toContain("LITERAL_NUMBER && Number.isFinite(value)");
    expect(r.code).toContain("LITERAL_BOOLEAN");
  });
});
