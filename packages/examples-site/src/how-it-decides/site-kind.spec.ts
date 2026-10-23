import { describe, expect, it } from "vitest";

import { siteKind } from "./site-kind.js";

describe("siteKind", () => {
  it("calls a parameter a parameter", () => {
    expect(
      siteKind(
        'function greet(user) {\n  return "Hi " + user.name;\n}\n',
        "user",
      ),
    ).toBe("parameter");
  });

  it("calls a parameter its function calls or constructs a callback", () => {
    expect(
      siteKind("function schedule(job) {\n  return job();\n}\n", "job"),
    ).toBe("callback");
    expect(siteKind("const step = (next) => next?.();\n", "next")).toBe(
      "callback",
    );
    expect(
      siteKind("function later(make) {\n  return new make();\n}\n", "make"),
    ).toBe("callback");
  });

  it("calls a binding a variable, and destructuring too", () => {
    expect(siteKind("const data = JSON.parse('{}');\n", "data")).toBe(
      "variable",
    );
    expect(siteKind("let { size } = { size: 1 };\n", "{ size }")).toBe(
      "variable",
    );
  });

  it("calls a class property a field", () => {
    expect(siteKind("class Store {\n  items = [];\n}\n", "items")).toBe(
      "field",
    );
  });

  it("knows a return type and `this` by name", () => {
    expect(siteKind("function f() {}\n", "return type")).toBe("return");
    expect(siteKind("function f() {}\n", "this")).toBe("this");
  });

  it("throws for a site the code does not declare", () => {
    expect(() => siteKind("const a = 1;\n", "b")).toThrow(/b/);
  });
});
