import { describe, expect, it } from "vitest";

import { renderPlaygroundPage } from "./page.js";

const starters = [
  { id: "one", title: "First <one>", code: "const a = 1;\n" },
  { id: "two", title: "Second", code: 'const tag = "</script><b>";\n' },
];

describe("renderPlaygroundPage", () => {
  const html = renderPlaygroundPage(starters);

  it("offers every starter, and opens with the first one in the editor", () => {
    expect(html).toContain('<option value="one">First &lt;one&gt;</option>');
    expect(html).toContain('<option value="two">Second</option>');
    expect(html).toMatch(/<textarea[^>]*>const a = 1;\n<\/textarea>/);
  });

  it("carries the starters as data a script tag cannot be closed by", () => {
    const data =
      /<script type="application\/json" id="starters">(.*?)<\/script>/s.exec(
        html,
      );
    expect(data).not.toBeNull();
    expect(data![1]).not.toContain("</script>");
    expect(JSON.parse(data![1])).toEqual(starters);
  });

  it("links back to the examples and loads the page script", () => {
    expect(html).toContain('<a href="../">Examples</a>');
    expect(html).toContain('<script type="module" src="main.js"></script>');
  });
});
