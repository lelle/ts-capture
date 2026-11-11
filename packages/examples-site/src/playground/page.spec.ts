import { describe, expect, it } from "vitest";

import { SWITCHES } from "./options.js";
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
    expect(html).toContain('<a href="../examples/">In real code</a>');
    expect(html).toContain(
      '<script type="module" src="../playground/main.js"></script>',
    );
  });

  const box = (page: string, id: string) =>
    new RegExp(`<input [^>]*id="${id}"[^>]*>`).exec(page)?.[0] ?? "";

  it("offers the options a config sets, each under its key in the reference", () => {
    for (const key of [
      "aliasRepeatedShapes",
      "skipRedundantAnnotations",
      "narrowParamShapes",
      "literal.string",
      "outputMode",
    ]) {
      expect(html).toContain(
        `<a href="../docs/reference/configuration/#infer"><code>infer.${key}</code></a>`,
      );
    }
    expect(html).toContain(
      '<label for="infer-narrowParamShapes">Narrow parameter shapes</label>',
    );
  });

  it("starts at the defaults, behind a closed summary that says nothing changed", () => {
    expect(html).toMatch(/<details class="options">\s*<summary>/);
    expect(html).toContain('<span id="changed"></span>');
    expect(box(html, "infer-aliasRepeatedShapes")).not.toContain("checked");
    expect(box(html, "infer-skipRedundantAnnotations")).toContain("checked");
    expect(box(html, "output-annotations")).toContain("checked");
    expect(box(html, "output-comments")).not.toContain("checked");
  });

  it("sets the options the first starter asks for, and counts them in the summary", () => {
    const naming = renderPlaygroundPage(
      [
        { ...starters[0]!, options: { aliasRepeatedShapes: true } },
        starters[1]!,
      ],
      { version: "0.4.0" },
    );
    expect(box(naming, "infer-aliasRepeatedShapes")).toContain("checked");
    expect(naming).toContain(
      '<span id="changed">1 changed from the defaults</span>',
    );
  });

  const shownFor = (page: string, kind: string) =>
    [...page.matchAll(new RegExp(`<[^>]* data-kind="${kind}"[^>]*>`, "g"))].map(
      (match) => match[0],
    );

  it("carries the words for both kinds of starter, showing those for the first", () => {
    expect(shownFor(html, "code").length).toBeGreaterThan(0);
    expect(shownFor(html, "json").length).toBeGreaterThan(0);
    expect(shownFor(html, "code").every((tag) => !tag.includes("hidden"))).toBe(
      true,
    );
    expect(shownFor(html, "json").every((tag) => tag.includes("hidden"))).toBe(
      true,
    );
    expect(html).toContain("Paste a JSON value");
  });

  it("shows the JSON words when the first starter is JSON", () => {
    const json = renderPlaygroundPage(
      [{ ...starters[0]!, kind: "json" }, starters[1]!],
      { version: "0.4.0" },
    );
    expect(shownFor(json, "json").every((tag) => !tag.includes("hidden"))).toBe(
      true,
    );
    expect(shownFor(json, "code").every((tag) => tag.includes("hidden"))).toBe(
      true,
    );
  });

  it("asks for the name and the depth only when typing JSON", () => {
    expect(html).toMatch(
      /<span [^>]*data-kind="json"[^>]*hidden[^>]*>[\s\S]*?id="root-name"/,
    );
    expect(box(html, "root-name")).toContain('placeholder="data"');
    expect(box(html, "max-depth")).not.toContain("value=");
  });

  it("says beside a switch what it costs, where a switch has a note", () => {
    for (const { key, note } of SWITCHES.filter((entry) => entry.note)) {
      const item = new RegExp(
        `<li><input [^>]*id="infer-${key}"[^]*?</li>`,
      ).exec(html)?.[0];
      expect(item).toContain(note);
    }
    expect(SWITCHES.some((entry) => entry.note)).toBe(true);
  });
});
