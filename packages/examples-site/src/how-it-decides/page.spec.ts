import { describe, expect, it } from "vitest";

import type { ExamplesData } from "../page.js";

import { type Cell, OUTCOMES } from "./cells.js";
import { type DecidedCell, renderDecidesPage, ruleLinks } from "./page.js";

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
const typeError: Cell = {
  kind: "parameter",
  outcome: "type-error",
  name: "settings",
  title: "A type the code would not compile with",
  why: "Written, that type would make the next line an error.",
  decidedBy: {
    file: "apply-types-verify.ts",
    symbol: "filterAcceptedReplacements",
  },
  code: "function enable(settings) {}\nenable({});\n",
  real: ["left-alone"],
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
    skip: { reason: "redundant", observed: "string", detail: undefined },
  },
  { cell: unreachable },
  { cell: typeError, after: typeError.code! },
];
const REAL: ExamplesData = {
  sources: {
    nest: {
      name: "nestjs/nest",
      about: "",
      url: null,
      commit: "09dba60ce",
      tsCapture: "feee61e",
    },
  },
  examples: [
    {
      id: "params-and-return",
      title: "Parameters and a return type",
      verdict: "good",
      caption: "From the calls.",
      source: "nest",
      file: "a.ts",
      line: 1,
      before: "function f(a) {}",
      after: "function f(a: string) {}",
    },
    {
      id: "left-alone",
      title: "A position it observed and did not write",
      verdict: "left",
      caption: "stock is not written.",
      leftAlone: {
        position: "a.ts:1:1",
        name: "stock",
        group: "Would add a type error",
        observed: "{ a: number }",
        reason: "TS7053",
      },
      source: "nest",
      file: "b.ts",
      line: 9,
      before: "function g(stock) {}",
      after: "function g(stock) {}",
    },
  ],
};

const BUILD = { version: "0.4.0" };
const page = renderDecidesPage(CARDS, REAL, BUILD);
const card = (id: string): string => {
  const start = page.indexOf(`<article id="${id}"`);
  return page.slice(start, page.indexOf("</article>", start));
};

describe("renderDecidesPage", () => {
  it("loads its menu from the site's scripts", () => {
    expect(page).toContain(
      '<script type="module" src="../js/how-it-decides.js"></script>',
    );
  });

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

  it("lays out like a docs page: bar and heading first, then the menu beside the cards", () => {
    const at = (marker: string): number => page.indexOf(marker);
    expect(at('<nav class="site"')).toBeLessThan(at("<h1>"));
    expect(at("<h1>")).toBeLessThan(at('<div class="layout">'));
    expect(at('<div class="layout">')).toBeLessThan(at('<nav class="toc"'));
    expect(at('<nav class="toc"')).toBeLessThan(at('<main id="content">'));
    expect(at("</main>")).toBeLessThan(at('<footer class="site"'));
  });

  it("shows a real example it left alone in full, inside its own card", () => {
    const left = card("parameter-type-error");
    expect(left).toContain(
      '<details class="real"><summary>In real code: A position it observed and did not write</summary>',
    );
    expect(left).toContain('class="note left-alone"');
    expect(left).not.toContain('href="../examples/#left-alone"');
  });

  it("points an example at the card that shows it most narrowly", () => {
    const callback: Cell = { ...written, kind: "callback", real: ["callback"] };
    expect(
      ruleLinks([
        { ...written, real: ["params-and-return", "callback"] },
        callback,
      ]),
    ).toEqual(
      new Map([
        [
          "params-and-return",
          {
            href: "../how-it-decides/#parameter-written",
            label: "Parameter · written",
          },
        ],
        [
          "callback",
          {
            href: "../how-it-decides/#callback-written",
            label: "Callback · written",
          },
        ],
      ]),
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
      BUILD,
    );
    expect(page).toContain("Typed as <code>Mode</code>, never &lt;b&gt;.");
  });

  it("shows the text the last apply was given, when the code changed after the run", () => {
    const moved: Cell = {
      ...unreachable,
      unreachable: undefined,
      code: "f(1);\n",
      applyTo: "// added\nf(1);\n",
    };
    const page = renderDecidesPage(
      [{ cell: moved, after: moved.applyTo!, appliedTo: moved.applyTo! }],
      REAL,
      BUILD,
    );
    expect(page).toContain('class="panes three"');
    expect(page).toContain("Changed before apply");
    expect(page).not.toContain("open in the playground");
  });

  it("groups each kind's cards in a section under the kind's heading", () => {
    const section = page.slice(
      page.indexOf('<section class="kind"'),
      page.indexOf("</section>"),
    );
    expect(section).toContain('<h2 class="kind-heading">Parameter</h2>');
    expect(section).toContain('<article id="parameter-written"');
    expect(section).toContain('<h3><a href="#parameter-written">');
  });

  // Two axes of the matrix: one kind selected, and the outcomes, with the ones
  // the selected kind does not have disabled.
  describe("the menu", () => {
    const returnWritten: Cell = {
      ...written,
      kind: "return",
      name: "return type",
    };
    const twoKinds = renderDecidesPage(
      [
        { cell: unreachable },
        { cell: returnWritten, after: written.code! },
        CARDS[0]!,
      ],
      REAL,
      BUILD,
    );
    const start = twoKinds.indexOf('<nav class="toc"');
    const menu = twoKinds.slice(start, twoKinds.indexOf("</nav>", start));
    const between = (from: string, to: string): string =>
      menu.slice(menu.indexOf(from), menu.indexOf(to, menu.indexOf(from)));

    it("lists the kinds, the first one selected", () => {
      const kinds = between('id="kinds"', "</ul>");
      expect(
        [...kinds.matchAll(/data-kind="([^"]+)"/g)].map((m) => m[1]),
      ).toEqual(["parameter", "return"]);
      expect(kinds).toMatch(/data-kind="parameter"[^>]*aria-current="true"/);
    });

    it("lists every outcome, and disables the ones the selected kind lacks", () => {
      const outcomes = between('id="outcomes"', "</ul>");
      expect(
        [...outcomes.matchAll(/data-outcome="([^"]+)"/g)].map((m) => m[1]),
      ).toEqual(OUTCOMES);
      expect(outcomes).toContain(
        'data-outcome="written" href="#parameter-written"',
      );
      expect(outcomes).toMatch(
        /data-outcome="redundant"[^>]*aria-disabled="true"/,
      );
    });

    it("tells the script which outcomes each kind has", () => {
      expect(menu).toContain('data-outcomes="written no-site"');
    });

    it("puts each kind's cards in the order of the outcome list", () => {
      const order = [...twoKinds.matchAll(/<article id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(order).toEqual([
        "parameter-written",
        "parameter-no-site",
        "return-written",
      ]);
    });

    it("folds behind a button on a narrow screen", () => {
      expect(menu).toContain(
        '<button type="button" class="toc-toggle" aria-expanded="false" aria-controls="toc-list">',
      );
    });
  });

  it("says why a cell has no example, and offers no playground", () => {
    expect(card("parameter-no-site")).toContain(
      "Only stale observations end here.",
    );
    expect(card("parameter-no-site")).not.toContain("playground");
  });
});
