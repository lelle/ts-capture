import { describe, expect, it } from "vitest";

import type { Cell } from "./cells.js";

import { type DecidedCell, renderDecidesPage } from "./page.js";

const written: Cell = {
  kind: "parameter",
  outcome: "written",
  name: "user",
  title: "What every call passed",
  why: "The run saw one shape.",
  decidedBy: { file: "cst-replacements.ts", symbol: "buildCstReplacements" },
  code: 'function greet(user) {}\ngreet({ name: "Ada" });\n',
  real: ["params-and-return"],
};
const redundant: Cell = {
  kind: "parameter",
  outcome: "redundant",
  name: "word",
  title: "TypeScript already knows",
  why: "Typed by where it is passed.",
  decidedBy: {
    file: "redundant-annotation.ts",
    symbol: "isRedundantAnnotation",
  },
  code: '["a"].map((word) => word.length);\n',
};
const unreachable: Cell = {
  kind: "parameter",
  outcome: "no-site",
  name: "",
  title: "The code moved",
  why: "The observation points nowhere.",
  decidedBy: { file: "cst-routing.ts", symbol: "routeEntries" },
  unreachable: "Only stale observations end here.",
};

const CARDS: DecidedCell[] = [
  {
    cell: written,
    after:
      'function greet(user: { name: string }) {}\ngreet({ name: "Ada" });\n',
  },
  {
    cell: redundant,
    after: redundant.code!,
    skip: { observed: "string", detail: undefined },
  },
  { cell: unreachable },
];
const REAL = new Map([["params-and-return", "Parameters and a return type"]]);

const page = renderDecidesPage(CARDS, REAL);
const card = (id: string): string => {
  const start = page.indexOf(`<article id="${id}"`);
  return page.slice(start, page.indexOf("</article>", start));
};

describe("renderDecidesPage", () => {
  it("leads with a grid: a row per kind, a link per outcome to its card", () => {
    expect(page).toContain('<th scope="row">Parameter</th>');
    expect(page).toContain('href="#parameter-written"');
    expect(page).toContain('href="#parameter-redundant"');
  });

  it("marks a cell that running code cannot reach in the grid", () => {
    expect(page).toMatch(
      /<td class="unreachable"><a href="#parameter-no-site"/,
    );
  });

  it("shows before and after, with what apply added marked", () => {
    expect(card("parameter-written")).toContain("<ins");
    expect(card("parameter-written")).toContain("Before");
  });

  it("says why, and what the run saw where nothing was written", () => {
    expect(card("parameter-written")).toContain("The run saw one shape.");
    expect(card("parameter-redundant")).toContain("<code>string</code>");
  });

  it("links to the code that decides it and to the test that checks it", () => {
    expect(card("parameter-redundant")).toContain(
      "https://github.com/lelle/ts-capture/blob/main/packages/core/src/redundant-annotation.ts",
    );
    expect(card("parameter-redundant")).toContain(
      "<code>isRedundantAnnotation</code>",
    );
    expect(card("parameter-redundant")).toContain(
      "packages/examples-site/src/how-it-decides/cells.spec.ts",
    );
  });

  it("opens the example in the playground", () => {
    expect(card("parameter-redundant")).toContain(
      `href="../playground/#code=${encodeURIComponent(redundant.code!)}"`,
    );
  });

  it("names the real examples in the cell", () => {
    expect(card("parameter-written")).toContain(
      '<a href="../examples/#params-and-return">Parameters and a return type</a>',
    );
  });

  it("sets what the explanation quotes in backticks as code", () => {
    const page = renderDecidesPage(
      [
        {
          cell: { ...written, why: "Typed as `Mode`, never <b>." },
          after: written.code!,
        },
      ],
      REAL,
    );
    expect(page).toContain("Typed as <code>Mode</code>, never &lt;b&gt;.");
  });

  it("says why a cell has no example, and offers no playground", () => {
    expect(card("parameter-no-site")).toContain(
      "Only stale observations end here.",
    );
    expect(card("parameter-no-site")).not.toContain("playground");
  });
});
