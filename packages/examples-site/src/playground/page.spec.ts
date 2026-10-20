import { describe, expect, it } from "vitest";

import { renderPlaygroundPage } from "./page.js";

const starters = [
  { id: "one", title: "First <one>", code: "const a = 1;\n" },
  { id: "two", title: "Second", code: 'const tag = "</script><b>";\n' },
];

describe("renderPlaygroundPage", () => {
  const html = renderPlaygroundPage(starters, { version: "0.4.0" });

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

  it("links to the front page and the examples, and loads the page script", () => {
    expect(html).toContain('<a href="../">ts-capture</a>');
    expect(html).toContain('<a href="../examples/">Examples</a>');
    expect(html).toContain('<script type="module" src="main.js"></script>');
  });

  it("offers naming repeated shapes, ticked when the first starter asks for it", () => {
    const box = (page: string) =>
      /<input type="checkbox" id="name-shapes"[^>]*>/.exec(page)?.[0] ?? "";
    expect(box(html)).not.toContain("checked");
    expect(html).toContain(
      '<label for="name-shapes">Name repeated shapes</label>',
    );
    const naming = renderPlaygroundPage(
      [{ ...starters[0]!, nameShapes: true }, starters[1]!],
      { version: "0.4.0" },
    );
    expect(box(naming)).toContain("checked");
  });
});
