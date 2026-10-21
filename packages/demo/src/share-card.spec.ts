import { describe, expect, it } from "vitest";

import { shareCardHtml } from "./share-card.js";

const EXAMPLE = {
  before: "function total(order) {\n  return order.sum;\n}",
  after:
    "function total(order: { sum: number }): number {\n  return order.sum;\n}",
};

describe("shareCardHtml", () => {
  it("shows the example after apply, with what apply wrote marked", () => {
    const html = shareCardHtml(EXAMPLE);
    expect(html).toContain("function");
    expect(html.match(/<ins>/g)).toHaveLength(2);
  });

  it("leaves out the lines apply did not reach, so the card holds the change", () => {
    const html = shareCardHtml({
      before: "const a = 1;\n\nfunction f(x) {}\n\nconst b = 2;",
      after: "const a = 1;\n\nfunction f(x: string) {}\n\nconst b = 2;",
    });
    expect(html).toContain("<ins>");
    expect(html).not.toContain("const");
  });
});
