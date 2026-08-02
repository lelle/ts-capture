import { describe, expect, it } from "vitest";

import { add, greet, isAdult } from "../src/math";

describe("math", () => {
  it("add", () => {
    expect(add(2, 3)).toBe(5);
    expect(add(-1, 1)).toBe(0);
  });

  it("greet", () => {
    expect(greet("Ada")).toBe("Hello, Ada!");
  });

  it("isAdult", () => {
    expect(isAdult({ name: "Bob", age: 30 })).toBe(true);
    expect(isAdult({ name: "Cara", age: 12 })).toBe(false);
  });
});
