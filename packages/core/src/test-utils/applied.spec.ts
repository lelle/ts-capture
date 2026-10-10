import { describe, expect, it } from "vitest";

import { INFER_DEFAULTS } from "../configuration.js";
import { newApplyTelemetry } from "../contract.js";
import { applied, checked, entry, parseErrors, printedAst, reapplied } from "./applied.js";

// The helper under test is what every converted spec will stand on, so each
// matcher is proved both ways here: it accepts what it should and names what
// it rejects.

const SHAPE = "{ a: number, b: string }";
const after = (src: string, needle: string): number => src.indexOf(needle) + needle.length;

const READS_A = "export function f(p) { return p.a; }\n";
const paramP = (src: string, type = SHAPE) => [entry("target.ts", after(src, "f(p"), [[type]])];

describe("applied", () => {
  it("applies through the CST applier and parses the result", () => {
    const out = applied(READS_A, paramP(READS_A));
    expect(parseErrors(out)).toEqual([]);
    expect(out.text).toContain("f(p: {");
  });

  it("applies through the offset applier on request", () => {
    const cst = applied(READS_A, paramP(READS_A));
    const offset = applied(READS_A, paramP(READS_A), { applier: "offset" });
    expect(printedAst(offset.text)).toBe(printedAst(cst.text));
  });

  it("re-applies the same entries to its own output without change", () => {
    const out = applied(READS_A, paramP(READS_A));
    expect(reapplied(out)).toBe(out.text);
  });

  it("runs the type-check oracle when asked", () => {
    const telemetry = newApplyTelemetry();
    const out = applied(READS_A, paramP(READS_A, "{ b: string }"), { verify: true, telemetry });
    expect(out).toLeaveUntyped("p");
    expect(telemetry.verifyReject).toBe(1);
  });

  it("lets the oracle see the other files of the project", () => {
    const out = applied(READS_A, paramP(READS_A, "{ a: number, b: string, c: boolean }"), {
      verify: true,
      files: { "other.ts": 'import { f } from "./target";\nf({ a: 1, b: "x" });\n' },
    });
    expect(out).toLeaveUntyped("p");
  });
});

describe("toAnnotate", () => {
  it("accepts the written shape in another spelling", () => {
    const out = applied(READS_A, paramP(READS_A));
    expect(out).toAnnotate("p", "{ b: string; a: number }");
  });

  it("names the written type when it differs", () => {
    const out = applied(READS_A, paramP(READS_A));
    expect(() => expect(out).toAnnotate("p", "{ a: number }")).toThrow(/a: number; b: string/);
  });

  it("matches a type reference by its name, and not by its shape", () => {
    const src = "type P = { a: number; b: string };\n" + READS_A;
    const out = applied(src, paramP(src));
    expect(out).toAnnotate("p", { ref: "P" });
    expect(() => expect(out).toAnnotate("p", SHAPE)).toThrow(/P/);
  });

  it("reaches a return type through the function's name", () => {
    const src = "export function g() { return 1; }\n";
    const out = applied(src, [
      entry("target.ts", after(src, "g()"), [["number"]], { returnType: true }),
    ]);
    expect(out).toAnnotate({ returnOf: "g" }, "number");
  });

  it("finds a function's parameter, not a same-named one in a function type", () => {
    const src = "export function f(cb: (p: unknown) => void) { cb(1); }\nf((p) => {});\n";
    const out = applied(src, [entry("target.ts", after(src, "f((p"), [["number"]])]);
    expect(out).toAnnotate("p", "number");
  });

  it("fails on a site that does not exist", () => {
    const out = applied(READS_A, paramP(READS_A));
    expect(() => expect(out).toAnnotate("q", "number")).toThrow(/no site named q/);
  });
});

describe("toLeaveUntyped", () => {
  it("passes where nothing was written and fails where something was", () => {
    const untyped = applied(READS_A, paramP(READS_A, "unknown"));
    expect(untyped).toLeaveUntyped("p");
    const typed = applied(READS_A, paramP(READS_A));
    expect(() => expect(typed).toLeaveUntyped("p")).toThrow(/a: number; b: string/);
  });
});

describe("toTypeAs", () => {
  it("sees through an alias to the type TypeScript has", () => {
    const src = "type P = { a: number; b: string };\n" + READS_A;
    const out = applied(src, paramP(src));
    expect(out).toTypeAs("p", "{ b: string; a: number }");
  });

  // The checker prints an interface by name, unlike a type alias.
  it("sees through an interface to its members", () => {
    const src = "interface P { a: number; b: string }\n" + READS_A;
    const out = applied(src, paramP(src));
    expect(out).toAnnotate("p", { ref: "P" });
    expect(out).toTypeAs("p", "{ b: string; a: number }");
  });

  it("renders an optional member with its question mark", () => {
    const src = "interface P { a: number; b?: string }\nexport function f(p: P) { return p.a; }\n";
    const out = applied(src, []);
    expect(out).toTypeAs("p", "{ a: number; b?: string }");
  });

  it("reports the type TypeScript has when it differs", () => {
    const out = applied(READS_A, paramP(READS_A));
    expect(() => expect(out).toTypeAs("p", "number")).toThrow(/a: number; b: string/);
  });

  it("answers for a return type", () => {
    const src = "export function g() { return 1; }\n";
    const out = applied(src, []);
    expect(out).toTypeAs({ returnOf: "g" }, "number");
  });
});

describe("toDeclareAlias", () => {
  it("finds a declaration the run added, by name and canonical body", () => {
    const src =
      "export function f(product) { return product.a; }\nexport function g(item) { return item.b; }\n";
    const out = applied(
      src,
      [
        entry("target.ts", after(src, "f(product"), [[SHAPE]]),
        entry("target.ts", after(src, "g(item"), [[SHAPE]]),
      ],
      { infer: { ...INFER_DEFAULTS, aliasRepeatedShapes: true } },
    );
    expect(out).toDeclareAlias("Product", "{ b: string; a: number }");
    expect(() => expect(out).toDeclareAlias("Item", SHAPE)).toThrow(/no alias named Item/);
  });
});

describe("toHaveNoNewDiagnostics", () => {
  const WITH_OLD_ERROR = READS_A + 'export const bad: number = "x";\n';

  it("does not count an error the input already had, wherever it moved to", () => {
    const out = applied(WITH_OLD_ERROR, paramP(WITH_OLD_ERROR));
    expect(out).toHaveNoNewDiagnostics();
  });

  it("names an error the annotation introduced", () => {
    const out = applied(WITH_OLD_ERROR, paramP(WITH_OLD_ERROR, "{ b: string }"));
    expect(() => expect(out).toHaveNoNewDiagnostics()).toThrow(/TS2339/);
  });
});

describe("checked", () => {
  it("reads an output someone else produced against its input", () => {
    const out = checked(READS_A, "export function f(p: { a: number }) { return p.a; }\n");
    expect(out).toAnnotate("p", "{ a: number }");
    expect(out).toTypeAs({ returnOf: "f" }, "number");
    expect(out).toHaveNoNewDiagnostics();
  });

  it("counts only the diagnostics the output added", () => {
    const withOldError = READS_A + 'export const bad: number = "x";\n';
    const out = checked(
      withOldError,
      'export function f(p: { b: string }) { return p.a; }\nexport const bad: number = "x";\n',
    );
    expect(out.newDiagnostics.map((d) => d.code)).toEqual([2339]);
  });
});

describe("toBeTheType", () => {
  it("accepts one type in another spelling, one string or a list", () => {
    expect("number|undefined").toBeTheType("undefined | number");
    expect(["{ a: number, b?: string }", "string[]"]).toBeTheType([
      "{ b?: string; a: number }",
      "Array<string>",
    ]);
  });

  it("names the type it got when it differs, and a null", () => {
    expect(() => expect("number|undefined").toBeTheType("number")).toThrow(/number \| undefined/);
    expect(() => expect(null).toBeTheType("number")).toThrow(/null/);
    expect(() => expect(["string"]).toBeTheType(["string", "number"])).toThrow(/2 types/);
  });
});
