import { describe, expect, it } from "vitest";

import { coveragePercent, terminalLines } from "./scenes.js";

describe("coveragePercent", () => {
  it("reads the percentage out of what `ts-capture coverage` prints", () => {
    expect(coveragePercent("Type coverage: 77.6% (83/107)\n")).toBe("77.6%");
  });

  it("refuses output that reports no coverage, so a broken run cannot be recorded", () => {
    expect(() => coveragePercent("Error: no tsconfig")).toThrow(/no coverage/);
  });
});

describe("terminalLines", () => {
  it("keeps the lines apply printed and drops the blank ones around them", () => {
    expect(
      terminalLines("\napply: 9 annotations written in 1 file.\n\n"),
    ).toEqual(["apply: 9 annotations written in 1 file."]);
  });
});
