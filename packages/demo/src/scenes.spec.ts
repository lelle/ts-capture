import { describe, expect, it } from "vitest";

import {
  animationArgs,
  coveragePercent,
  stillName,
  terminalLines,
} from "./scenes.js";

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

describe("stillName", () => {
  it("names a step's 2x still apart from its 1x one, which a page loads by default", () => {
    expect(stillName(3, 1)).toBe("demo-3.webp");
    expect(stillName(3, 2)).toBe("demo-3@2x.webp");
  });
});

describe("animationArgs", () => {
  it("holds each step 3.5 s and the last 5 s, and loops without loss", () => {
    const args = animationArgs(["a.png", "b.png", "c.png"], "demo.webp");
    expect(args.slice(0, 3)).toEqual(["-loop", "0", "-lossless"]);
    expect(args.slice(-2)).toEqual(["-o", "demo.webp"]);
    const held = args.flatMap((arg, i) =>
      arg === "-d" ? [[args[i + 2], args[i + 1]]] : [],
    );
    expect(held).toEqual([
      ["a.png", "3500"],
      ["b.png", "3500"],
      ["c.png", "5000"],
    ]);
  });
});
