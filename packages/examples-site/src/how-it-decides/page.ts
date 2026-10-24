import { renderCode } from "../code.js";
import { type BuildInfo, renderLayout, REPO } from "../layout.js";
import { escapeHtml, join, Markup, markup, trusted } from "../markup.js";
import {
  type ExamplesData,
  renderExampleBody,
  type RuleLink,
} from "../page.js";
import { type CorpusRule, OUTCOMES, type SiteKind } from "./corpus.js";
import { type DecidedExample } from "./decide.js";
import { DECIDED_BY, STAGES } from "./rules.js";

/** A rule and its examples, run. */
export interface DecidedRule {
  rule: CorpusRule;
  examples: DecidedExample[];
}

const CORE = `${REPO}/blob/main/packages/core/src`;
const CORPUS = `${REPO}/blob/main/packages/core/corpus`;

const KINDS: Record<SiteKind, string> = {
  parameter: "Parameter",
  return: "Return type",
  variable: "Variable",
  field: "Class field",
  callback: "Callback",
  this: "this",
};

const anchor = ({ example }: DecidedExample): string =>
  `${example.rule}--${example.name}`;

/** Escaped prose, with what it quotes in backticks set as code. */
const prose = (text: string): Markup =>
  trusted(escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>"));

/** The same prose as plain text, for a tooltip or a label. */
const plain = (text: string): string => text.replace(/`/g, "");

/** Kinds down, outcomes across; in each square, the rules an example ends in there. */
function renderGrid(rules: DecidedRule[]): Markup {
  const decided = rules.flatMap(({ rule, examples }) =>
    examples.map((example) => ({ rule, example })),
  );
  const kinds = (Object.keys(KINDS) as SiteKind[]).filter((kind) =>
    decided.some(({ example }) => example.kind === kind),
  );
  const head = OUTCOMES.map(
    (outcome) => markup`<th scope="col">${outcome}</th>`,
  );
  const rows = kinds.map((kind) => {
    const cells = OUTCOMES.map((outcome) => {
      const here = rules
        .filter(({ examples }) =>
          examples.some(
            (e) => e.kind === kind && e.atSite?.outcome === outcome,
          ),
        )
        .map(
          ({ rule }) =>
            markup`<a href="#${rule.id}" title="${plain(rule.title)}">●</a>`,
        );
      return markup`<td>${join(here, "")}</td>`;
    });
    return markup`<tr><th scope="row">${KINDS[kind]}</th>${cells}</tr>`;
  });
  return markup`<div class="grid-scroll"><table class="grid">
  <thead><tr><td></td>${head}</tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="how">Each ● is a rule that ends there, for that kind of position. It links to the rule.</p>`;
}

function renderExample(decided: DecidedExample, real: ExamplesData): Markup {
  const { example, kind, after, appliedTo, atSite } = decided;
  const outcome =
    atSite?.outcome === "written"
      ? "Written"
      : atSite && markup`Not written: <code>${atSite.outcome}</code>`;
  const panes =
    appliedTo !== undefined
      ? markup`<div class="panes three">
        <figure><figcaption>Run</figcaption><pre><code>${renderCode(example.code, example.code)}</code></pre></figure>
        <figure><figcaption>${example.apply === "twice" ? "After the first apply" : "Changed before apply"}</figcaption><pre><code>${renderCode(example.code, appliedTo)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(appliedTo, after)}</code></pre></figure>
      </div>`
      : markup`<div class="panes">
        <figure><figcaption>Before</figcaption><pre><code>${renderCode(example.code, example.code)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(example.code, after)}</code></pre></figure>
      </div>`;
  const saw =
    atSite?.observed &&
    markup`<dt>Observed</dt><dd><code>${atSite.observed}</code>${atSite.detail && markup` · ${atSite.detail}`}</dd>`;
  const found = example.real.flatMap((id) => {
    const match = real.examples.find((candidate) => candidate.id === id);
    return match ? [match] : [];
  });
  // A real example left alone lives here, beside its rule; the written ones
  // live on Examples.
  const named = found
    .filter((match) => match.verdict !== "left")
    .map(
      (match) => markup`<a href="../examples/#${match.id}">${match.title}</a>`,
    );
  const shown = join(
    found
      .filter((match) => match.verdict === "left")
      .map(
        (match) =>
          markup`<details class="real"><summary>In real code: ${match.title}</summary>${renderExampleBody(match, real.sources[match.source]!)}</details>`,
      ),
    "\n",
  );
  const links = [
    markup`<a href="${CORPUS}/${example.rule}/${example.name}.ts">the corpus file</a>`,
    // The playground runs one text, as written, with the default options.
    !example.apply &&
      Object.keys(example.infer).length === 0 &&
      markup`<a href="../playground/#code=${encodeURIComponent(example.code)}">open in the playground</a>`,
  ].filter((link): link is Markup => link instanceof Markup);
  const site =
    kind === "return" || kind === "this"
      ? ""
      : markup` <code>${example.site}</code>`;
  return markup`<article id="${anchor(decided)}" class="example">
      <header>
        <h4><a href="#${anchor(decided)}">${prose(example.title)}</a></h4>
        <p class="meta"><span class="source">${KINDS[kind]}${site}</span> <span>${outcome}</span></p>
      </header>
      ${panes}
      <p class="caption">${prose(example.why)}</p>
      <dl class="note">
        ${saw}
        <dt>See</dt><dd>${join(links, " · ")}</dd>
        ${named.length > 0 && markup`<dt>In real code</dt><dd>${join(named, ", ")}</dd>`}
      </dl>
      ${shown}
    </article>`;
}

function renderRule(
  { rule, examples }: DecidedRule,
  real: ExamplesData,
): Markup {
  const { file, symbol } = DECIDED_BY[rule.id];
  const body =
    examples.length > 0
      ? join(
          examples.map((example) => renderExample(example, real)),
          "\n",
        )
      : markup`<p class="note">No example on this page: the page runs every example the way the playground does, and this rule needs a run it cannot make.</p>`;
  return markup`<section class="rule-section" id="${rule.id}">
    <h3><a href="#${rule.id}">${prose(rule.title)}</a></h3>
    <p class="meta"><code>${rule.id}</code> · decided in <a href="${CORE}/${file}">${file}</a> <code>${symbol}</code></p>
    <p class="about">${prose(rule.about)}</p>
    ${body}
  </section>`;
}

const staged = (rules: DecidedRule[]) =>
  STAGES.map((stage) => ({
    stage,
    rules: stage.rules.flatMap((id) =>
      rules.filter(({ rule }) => rule.id === id),
    ),
  })).filter(({ rules: those }) => those.length > 0);

/** The stages, each with its rules and their examples, beside the page; folded on a narrow screen. */
function renderToc(rules: DecidedRule[]): Markup {
  const groups = staged(rules).map(
    ({ stage, rules: those }) =>
      markup`<p class="toc-kind">${stage.title}</p><ul>${those.map(
        ({ rule, examples }) =>
          markup`<li><a href="#${rule.id}">${prose(rule.title)}</a>${
            examples.length > 0 &&
            markup`<ul class="toc-cards">${examples.map(
              (decided) =>
                markup`<li><a href="#${anchor(decided)}">${prose(decided.example.title)}</a></li>`,
            )}</ul>`
          }</li>`,
      )}</ul>`,
  );
  return markup`<nav class="toc" aria-label="Rules">
  <button type="button" class="toc-toggle" aria-expanded="false" aria-controls="toc-list"><span class="toc-current">Rules</span></button>
  <div id="toc-list" class="toc-list">
    ${join(groups, "\n")}
  </div>
</nav>`;
}

function renderSections(rules: DecidedRule[], real: ExamplesData): Markup {
  return join(
    staged(rules).map(
      ({
        stage,
        rules: those,
      }) => markup`<section class="kind" id="stage-${stage.id}">
  <h2 class="kind-heading">${stage.title}</h2>
${join(
  those.map((rule) => renderRule(rule, real)),
  "\n",
)}
</section>`,
    ),
    "\n",
  );
}

/** For each real example, the example on the page that stands for the fewest: the most specific. */
export function ruleLinks(rules: DecidedRule[]): Map<string, RuleLink> {
  const best = new Map<string, { decided: DecidedExample; rule: CorpusRule }>();
  for (const { rule, examples } of rules) {
    for (const decided of examples) {
      for (const id of decided.example.real) {
        const current = best.get(id);
        if (
          !current ||
          decided.example.real.length < current.decided.example.real.length
        ) {
          best.set(id, { decided, rule });
        }
      }
    }
  }
  return new Map(
    [...best].map(([id, { decided, rule }]) => [
      id,
      {
        href: `../how-it-decides/#${anchor(decided)}`,
        label: `${KINDS[decided.kind]} · ${plain(rule.title)}`,
      },
    ]),
  );
}

/** `real` holds the examples from real runs that the examples point to. */
export function renderDecidesPage(
  rules: DecidedRule[],
  real: ExamplesData,
  build: BuildInfo,
): string {
  return renderLayout(
    {
      id: "how-it-decides",
      title: "How it decides",
      description:
        "Every rule ts-capture apply decides a position by: what it writes, what it refuses to write, and the code that decides it.",
      top: markup`<h1>How it decides</h1>
  <p class="lede">For every position the tests passed through, <code>apply</code> either writes the type it saw or leaves the position alone, and says why. Each section below is one rule it decides by, with small files that end there: run, applied, and the code that made the call. How good the types it writes are, in real projects, is on <a href="../examples/">In real code</a>.</p>
  <p class="how">The examples are not written by hand: each is run through the same applier as the playground when the page is built, and a test checks that it still ends in its rule.</p>
  ${renderGrid(rules)}`,
      body: markup`<div class="layout">
${renderToc(rules)}
<main id="content">
${renderSections(rules, real)}
</main>
</div>`,
    },
    build,
  );
}
