import { describe, expect, it } from "vitest";

import { renderCode } from "./code.js";
import { type ExamplesData, renderExampleBody, renderPage } from "./page.js";

const DATA: ExamplesData = {
  sources: {
    "mini-app": {
      name: "mini-app",
      about: "A small untyped app.",
      url: null,
      commit: "d99f8ca",
      tsCapture: "1756e50",
    },
    nest: {
      name: "nestjs/nest",
      about: "The NestJS framework.",
      url: "https://github.com/nestjs/nest",
      commit: "09dba60ce",
      tsCapture: "feee61e",
    },
  },
  examples: [
    {
      id: "left-alone",
      title: "A position it did not write",
      verdict: "left",
      caption: "threshold is written; stock is not.",
      leftAlone: {
        position: "src/inventory.ts:9:26",
        name: "stock",
        group: "Would add a type error",
        observed: '{ "sku-lamp": number }',
        reason: "TS7053 at src/inventory.ts:10: can't index <that>.",
      },
      source: "mini-app",
      file: "src/inventory.ts",
      line: 9,
      before: "export function lowStock(stock, threshold) {",
      after: "export function lowStock(stock, threshold: number) {",
    },
    {
      id: "generic",
      title: "Angle brackets",
      verdict: "weak",
      caption: "A Map<string, number> & more.",
      better: "Record<string, number>",
      source: "nest",
      file: "packages/core/a.ts",
      line: 12,
      before: "const m = new Map();",
      after: "const m: Map<string, number> = new Map();",
    },
  ],
};

describe("renderCode", () => {
  it("wraps what apply added in ins and colours the rest", () => {
    expect(renderCode("f(a)", "f(a: string)")).toBe(
      '<span class="t-name">f</span>(<span class="t-name">a</span><ins>: <span class="t-type">string</span></ins>)',
    );
  });

  it("escapes code that looks like markup", () => {
    expect(renderCode("a", "a as Map<string, number>")).toContain("&lt;");
    expect(renderCode("a", "a as Map<string, number>")).not.toContain(
      "<string",
    );
  });
});

describe("renderPage", () => {
  const html = renderPage(DATA, { version: "0.4.0" });

  it("has a card for every example it wrote, and leaves the ones it left alone to How it decides", () => {
    expect(
      [...html.matchAll(/<article id="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual(["generic"]);
    expect(html).not.toContain('data-value="left"');
  });

  it("links an example to the rule that decided it, where one does", () => {
    const linked = renderPage(
      DATA,
      { version: "0.4.0" },
      new Map([
        [
          "generic",
          {
            href: "../how-it-decides/#variable-written",
            label: "Variable · written",
          },
        ],
      ]),
    );
    expect(linked).toContain(
      '<p class="rule"><a href="../how-it-decides/#variable-written">The rule: Variable · written →</a></p>',
    );
    expect(html).not.toContain('class="rule"');
  });

  it("links a public project's example to the file at the commit it was run on", () => {
    expect(html).toContain(
      'href="https://github.com/nestjs/nest/blob/09dba60ce/packages/core/a.ts#L12"',
    );
  });

  it("does not link a project that has no public home", () => {
    expect(html).not.toMatch(/href="[^"]*src\/inventory\.ts/);
  });

  it("shows what a reviewer would write for a weak result", () => {
    expect(html).toContain("Record&lt;string, number&gt;");
  });

  it("shows what was observed and why it was left, for a position not written", () => {
    const body = renderExampleBody(
      DATA.examples[0]!,
      DATA.sources["mini-app"]!,
    );
    expect(body).toContain("{ &quot;sku-lamp&quot;: number }");
    expect(body).toContain("can&#39;t index &lt;that&gt;.");
  });

  it("escapes captions", () => {
    expect(html).toContain("A Map&lt;string, number&gt; &amp; more.");
  });

  it("names the revision of ts-capture each project was run with", () => {
    expect(html).toContain("1756e50");
    expect(html).toContain("feee61e");
  });

  it("links to the front page and the playground, from its own folder", () => {
    expect(html).toContain('<a href="../">ts-capture</a>');
    expect(html).toContain('<a href="../playground/">Playground</a>');
  });
});
