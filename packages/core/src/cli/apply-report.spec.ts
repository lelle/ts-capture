import { describe, expect, it } from "vitest";

import { newApplyTelemetry } from "../contract.js";
import { type LocatedSkip, locateSite, reportLines } from "./apply-report.js";

const skip = (reason: LocatedSkip["reason"], name: string): LocatedSkip => ({
  pos: 0,
  reason,
  observed: "number",
  file: "/src/a.ts",
  line: 1,
  column: 1,
  name,
});

describe("reportLines", () => {
  it("counts the positions already annotated from the skips", () => {
    const telemetry = newApplyTelemetry();
    const lines = reportLines(telemetry, [
      skip("already-annotated", "a"),
      skip("already-annotated", "b"),
      skip("redundant", "c"),
    ]);
    expect(lines.join("\n")).toContain(
      "Nothing to add (3)\n  1 already inferred by TypeScript\n  2 already annotated",
    );
  });

  it("counts a variable left for TypeScript to infer as nothing to add", () => {
    const lines = reportLines(newApplyTelemetry(), [skip("left-to-typescript", "p")]);
    expect(lines.join("\n")).toContain("Nothing to add (1)\n  1 left for TypeScript to infer");
  });

  it("counts a position marked @ts-capture-ignore as nothing to add", () => {
    const lines = reportLines(newApplyTelemetry(), [skip("ignored", "a")]);
    expect(lines.join("\n")).toContain("Nothing to add (1)\n  1 marked @ts-capture-ignore");
  });

  it("names the rule that left a position unwritten", () => {
    const lines = reportLines(newApplyTelemetry(), [
      { ...skip("type-error", "total"), rule: "verify.type-error" },
    ]);
    expect(lines.join("\n")).toContain(
      "    /src/a.ts:1:1  total\n      observed  number\n      rule  verify.type-error",
    );
  });

  it("lists a position that is no place for a type under what was not written", () => {
    const lines = reportLines(newApplyTelemetry(), [skip("no-site", "total")]);
    expect(lines.join("\n")).toContain(
      "Observed but not written (1)\n\n  No place to write it - has the code changed since the run? (1)\n    /src/a.ts:1:1  total",
    );
  });
});

describe("locateSite", () => {
  const nameAt = (source: string, before: string): string =>
    locateSite(
      { pos: source.indexOf(before) + before.length, reason: "redundant", observed: "" },
      "/src/a.ts",
      source,
    ).name;

  it("names a parameter or variable after itself", () => {
    expect(nameAt("function f(count) {}", "count")).toBe("count");
    expect(nameAt("let total = 1;", "total")).toBe("total");
  });

  it("names the site after a parameter list the return type", () => {
    expect(nameAt("function f(a) {}", "(a)")).toBe("return type");
  });

  it("names the site at the start of a parameter list `this`", () => {
    expect(nameAt("function f() {}", "f(")).toBe("this");
  });

  it("names a destructuring after its pattern", () => {
    expect(nameAt("let { size } = { size: 1 };", "{ size }")).toBe("{ size }");
    expect(nameAt("let [first] = [1];", "[first]")).toBe("[first]");
  });
});
