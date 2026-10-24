import { describe, expect, it } from "vitest";

import type { ExamplesData } from "../page.js";
import type { CorpusExample, CorpusRule } from "./corpus.js";
import type { DecidedExample } from "./decide.js";

import { type DecidedRule, renderDecidesPage, ruleLinks } from "./page.js";

const example = (over: Partial<CorpusExample>): CorpusExample => ({
  rule: "written",
  name: "what-every-call-passed",
  site: "user",
  title: "What every call passed",
  real: [],
  infer: {},
  verdict: "ok",
  why: "The run saw one shape.",
  code: 'function greet(user) {}\ngreet({ name: "Ada" });\n',
  ...over,
});

const written = example({ real: ["params-and-return"] });
const typeError = example({
  rule: "verify.type-error",
  name: "a-type-the-code-would-not-compile-with",
  site: "settings",
  title: "A type the code would not compile with",
  why: "Written, that type would make the next line an error.",
  code: "function enable(settings) {}\nenable({});\n",
  real: ["left-alone"],
});
const redundant = example({
  rule: "gate.redundant",
  name: "typescript-already-knows",
  site: "word",
  title: "TypeScript already knows",
  why: "Typed by where it is passed.",
  code: '["a"].map((word) => word.length);\n',
});

const rule = (
  id: CorpusRule["id"],
  title: string,
  about: string,
): CorpusRule => ({
  id,
  title,
  about,
  examples: [],
});

const decided = (
  ex: CorpusExample,
  over: Partial<DecidedExample> = {},
): DecidedExample => ({
  example: ex,
  kind: "parameter",
  after: ex.code,
  ...over,
});

const RULES: DecidedRule[] = [
  {
    rule: rule("written", "Written", "The run saw a type."),
    examples: [
      decided(written, {
        after:
          'function greet(user: { name: string }) {}\ngreet({ name: "Ada" });\n',
        atSite: {
          outcome: "written",
          rule: "written",
          observed: "{ name: string }",
        },
      }),
    ],
  },
  {
    rule: rule(
      "gate.redundant",
      "TypeScript already knows",
      "TypeScript infers the same type.",
    ),
    examples: [
      decided(redundant, {
        atSite: {
          outcome: "redundant",
          rule: "gate.redundant",
          observed: "string",
        },
      }),
    ],
  },
  {
    rule: rule(
      "verify.type-error",
      "A type the code would not compile with",
      "It would add an error.",
    ),
    examples: [
      decided(typeError, {
        atSite: {
          outcome: "type-error",
          rule: "verify.type-error",
          observed: "{}",
        },
      }),
    ],
  },
  {
    rule: rule(
      "syntax.redundant-initializer",
      "Without a project",
      "Read from the initializer.",
    ),
    examples: [],
  },
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
const page = renderDecidesPage(RULES, REAL, BUILD);
const section = (id: string): string => {
  const start = page.indexOf(`<section class="rule-section" id="${id}"`);
  return page.slice(start, page.indexOf("</section>", start));
};
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

  it("leads with a grid: a row per kind, and in each square the rules that end there", () => {
    expect(page).toContain('<th scope="row">Parameter</th>');
    expect(page).toContain(
      '<a href="#gate.redundant" title="TypeScript already knows">●</a>',
    );
    expect(page).toContain('<a href="#written" title="Written">●</a>');
  });

  it("groups the rules under the stage that asks them, in the order apply asks", () => {
    const stages = [
      ...page.matchAll(/<section class="kind" id="stage-([^"]+)"/g),
    ].map((m) => m[1]);
    expect(stages).toEqual(["syntax", "gate", "verify", "written"]);
    expect(page).toContain(
      '<h2 class="kind-heading">From what TypeScript infers</h2>',
    );
  });

  it("heads each rule with its title, its id, what it is about and where it is decided", () => {
    const redundantRule = section("gate.redundant");
    expect(redundantRule).toContain(
      '<h3><a href="#gate.redundant">TypeScript already knows</a></h3>',
    );
    expect(redundantRule).toContain("<code>gate.redundant</code>");
    expect(redundantRule).toContain("TypeScript infers the same type.");
    expect(redundantRule).toContain(
      "https://github.com/lelle/ts-capture/blob/main/packages/core/src/redundant-annotation.ts",
    );
    expect(redundantRule).toContain("<code>isRedundantAnnotation</code>");
  });

  it("says so where a rule has no example the page can run", () => {
    expect(section("syntax.redundant-initializer")).toContain(
      "No example on this page",
    );
  });

  it("shows each example before and after, with what apply added marked", () => {
    const shown = card("written--what-every-call-passed");
    expect(shown).toContain(
      '<h4><a href="#written--what-every-call-passed">What every call passed</a></h4>',
    );
    expect(shown).toContain("Before");
    expect(shown).toContain("<ins");
  });

  it("says which kind of position it is, and what happened there", () => {
    expect(card("gate.redundant--typescript-already-knows")).toContain(
      "Parameter <code>word</code>",
    );
    expect(card("gate.redundant--typescript-already-knows")).toContain(
      "Not written: <code>redundant</code>",
    );
  });

  it("says why, and what the run saw", () => {
    expect(card("written--what-every-call-passed")).toContain(
      "The run saw one shape.",
    );
    expect(card("gate.redundant--typescript-already-knows")).toContain(
      "<code>string</code>",
    );
  });

  it("links to the corpus file it is, and opens it in the playground", () => {
    const shown = card("gate.redundant--typescript-already-knows");
    expect(shown).toContain(
      "https://github.com/lelle/ts-capture/blob/main/packages/core/corpus/gate.redundant/typescript-already-knows.ts",
    );
    expect(shown).toContain(
      `href="../playground/#code=${encodeURIComponent(redundant.code)}"`,
    );
  });

  it("sets a title's backticks as code, and leaves them out of a tooltip", () => {
    const html = renderDecidesPage(
      [
        {
          rule: rule(
            "syntax.only-undefined-seen",
            "Only `undefined` was seen",
            "",
          ),
          examples: [
            decided(
              example({
                rule: "syntax.only-undefined-seen",
                title: "A `get` that missed",
              }),
              {
                atSite: {
                  outcome: "left-to-typescript",
                  rule: "syntax.only-undefined-seen",
                },
              },
            ),
          ],
        },
      ],
      REAL,
      BUILD,
    );
    expect(html).toContain(
      '<h3><a href="#syntax.only-undefined-seen">Only <code>undefined</code> was seen</a></h3>',
    );
    expect(html).toContain(
      '<li><a href="#syntax.only-undefined-seen">Only <code>undefined</code> was seen</a>',
    );
    expect(html).toContain("A <code>get</code> that missed");
    expect(html).toContain('title="Only undefined was seen"');
  });

  it("sets what the explanation quotes in backticks as code", () => {
    const quoted = renderDecidesPage(
      [
        {
          rule: RULES[0]!.rule,
          examples: [decided(example({ why: "Typed as `Mode`, never <b>." }))],
        },
      ],
      REAL,
      BUILD,
    );
    expect(quoted).toContain("Typed as <code>Mode</code>, never &lt;b&gt;.");
  });

  it("shows the text the last apply was given, when the code changed after the run", () => {
    const moved = example({ apply: "moved" });
    const changed = "// added\n" + moved.code;
    const html = renderDecidesPage(
      [
        {
          rule: RULES[0]!.rule,
          examples: [decided(moved, { after: changed, appliedTo: changed })],
        },
      ],
      REAL,
      BUILD,
    );
    expect(html).toContain('class="panes three"');
    expect(html).toContain("Changed before apply");
    expect(html).not.toContain("open in the playground");
  });

  it("leaves out the playground link for an example run with its own options, which a link cannot carry", () => {
    const html = renderDecidesPage(
      [
        {
          rule: RULES[0]!.rule,
          examples: [
            decided(example({ infer: { skipRedundantAnnotations: false } })),
          ],
        },
      ],
      REAL,
      BUILD,
    );
    expect(html).not.toContain("open in the playground");
  });

  it("lays out like a docs page: bar and heading first, then the menu beside the rules", () => {
    const at = (marker: string): number => page.indexOf(marker);
    expect(at('<nav class="site"')).toBeLessThan(at("<h1>"));
    expect(at("<h1>")).toBeLessThan(at('<div class="layout">'));
    expect(at('<div class="layout">')).toBeLessThan(at('<nav class="toc"'));
    expect(at('<nav class="toc"')).toBeLessThan(at('<main id="content">'));
    expect(at("</main>")).toBeLessThan(at('<footer class="site"'));
  });

  it("shows a real example it left alone in full, inside its own example", () => {
    const left = card(
      "verify.type-error--a-type-the-code-would-not-compile-with",
    );
    expect(left).toContain(
      '<details class="real"><summary>In real code: A position it observed and did not write</summary>',
    );
    expect(left).toContain('class="note left-alone"');
    expect(left).not.toContain('href="../examples/#left-alone"');
  });

  it("names the real examples an example stands for", () => {
    expect(card("written--what-every-call-passed")).toContain(
      '<a href="../examples/#params-and-return">Parameters and a return type</a>',
    );
  });

  it("sends how good a written type is to the page of real code", () => {
    expect(page).toContain(
      'How good the types it writes are, in real projects, is on <a href="../examples/">In real code</a>.',
    );
  });

  describe("the menu", () => {
    const start = page.indexOf('<nav class="toc"');
    const menu = page.slice(start, page.indexOf("</nav>", start));

    it("lists the rules under their stages", () => {
      expect(menu).toContain(
        '<p class="toc-kind">From what TypeScript infers</p>',
      );
      expect(menu).toContain(
        '<a href="#gate.redundant">TypeScript already knows</a>',
      );
    });

    it("lists each rule's examples under it", () => {
      expect(menu).toContain(
        '<a href="#gate.redundant">TypeScript already knows</a><ul class="toc-cards"><li><a href="#gate.redundant--typescript-already-knows">TypeScript already knows</a></li></ul>',
      );
    });

    it("folds behind a button on a narrow screen", () => {
      expect(menu).toContain(
        '<button type="button" class="toc-toggle" aria-expanded="false" aria-controls="toc-list">',
      );
    });
  });
});

describe("ruleLinks", () => {
  it("points a real example at the example that stands for the fewest", () => {
    const both = example({ real: ["params-and-return", "callback"] });
    const callback = example({ name: "a-function", real: ["callback"] });
    expect(
      ruleLinks([
        {
          rule: RULES[0]!.rule,
          examples: [
            decided(both, { atSite: { outcome: "written", rule: "written" } }),
            decided(callback, {
              kind: "callback",
              atSite: { outcome: "written", rule: "written" },
            }),
          ],
        },
      ]),
    ).toEqual(
      new Map([
        [
          "params-and-return",
          {
            href: "../how-it-decides/#written--what-every-call-passed",
            label: "Parameter · Written",
          },
        ],
        [
          "callback",
          {
            href: "../how-it-decides/#written--a-function",
            label: "Callback · Written",
          },
        ],
      ]),
    );
  });
});
