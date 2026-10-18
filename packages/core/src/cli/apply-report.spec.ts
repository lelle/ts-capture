import { describe, expect, it } from "vitest";

import { newApplyTelemetry } from "../contract.js";
import { type LocatedSkip, reportLines } from "./apply-report.js";

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

  it("lists a position that is no place for a type under what was not written", () => {
    const lines = reportLines(newApplyTelemetry(), [skip("no-site", "total")]);
    expect(lines.join("\n")).toContain(
      "Observed but not written (1)\n\n  No place to write it - has the code changed since the run? (1)\n    /src/a.ts:1:1  total",
    );
  });
});
