import { describe, expect, it } from "vitest";

import { codeFromHash } from "./link.js";

describe("codeFromHash", () => {
  it("reads the code a link carries", () => {
    const code = 'greet({ name: "Ada & Bo" });\n';
    expect(codeFromHash(`#code=${encodeURIComponent(code)}`)).toBe(code);
  });

  it("is undefined for a page opened without code", () => {
    expect(codeFromHash("")).toBeUndefined();
    expect(codeFromHash("#starter=cart")).toBeUndefined();
  });

  it("is undefined for a link that does not decode", () => {
    expect(codeFromHash("#code=%E0%A4%A")).toBeUndefined();
  });
});
