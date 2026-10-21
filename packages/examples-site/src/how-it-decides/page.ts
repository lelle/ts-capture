import { renderCode } from "../code.js";
import { type BuildInfo, renderLayout, REPO } from "../layout.js";
import { escapeHtml, join, Markup, markup, trusted } from "../markup.js";
import {
  type ExamplesData,
  renderExampleBody,
  type RuleLink,
} from "../page.js";
import { type Cell, type Outcome, OUTCOMES, type SiteKind } from "./cells.js";

/** A cell, run: what apply wrote, and what it said where it wrote nothing. */
export interface DecidedCell {
  cell: Cell;
  after?: string;
  /** The text the last apply was given, when it was not the code that ran. */
  appliedTo?: string;
  skip?: {
    reason: string;
    observed: string | undefined;
    detail: string | undefined;
  };
}

const CORE = `${REPO}/blob/main/packages/core/src`;
const TEST = `${REPO}/blob/main/packages/examples-site/src/how-it-decides/cells.spec.ts`;

const KINDS: Record<SiteKind, string> = {
  parameter: "Parameter",
  return: "Return type",
  variable: "Variable",
  field: "Class field",
  callback: "Callback",
  this: "this",
};

const anchor = (cell: Cell): string => `${cell.kind}-${cell.outcome}`;

/** Escaped prose, with what it quotes in backticks set as code. */
const prose = (text: string): Markup =>
  trusted(escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>"));

/** What the grid's marks mean, for the marks it has. */
function legend(cards: DecidedCell[]): string {
  const parts = ["● an example you can run"];
  if (cards.some(({ cell }) => !cell.code)) {
    parts.push("○ running code cannot get there; the card says why");
  }
  parts.push("empty: not an outcome for that kind");
  return parts.join(" · ");
}

function renderGrid(cards: DecidedCell[]): Markup {
  const kinds = [...new Set(cards.map(({ cell }) => cell.kind))];
  const head = OUTCOMES.map(
    (outcome) => markup`<th scope="col">${outcome}</th>`,
  );
  const rows = kinds.map((kind) => {
    const cells = OUTCOMES.map((outcome: Outcome) => {
      const found = cards.find(
        ({ cell }) => cell.kind === kind && cell.outcome === outcome,
      );
      if (!found) return markup`<td></td>`;
      const cls = !found.cell.code && markup` class="unreachable"`;
      return markup`<td${cls}><a href="#${anchor(found.cell)}" title="${found.cell.title}">${found.cell.code ? "●" : "○"}</a></td>`;
    });
    return markup`<tr><th scope="row">${KINDS[kind]}</th>${cells}</tr>`;
  });
  return markup`<div class="grid-scroll"><table class="grid">
  <thead><tr><td></td>${head}</tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="how">${legend(cards)}</p>`;
}

function renderCard(
  { cell, after, appliedTo, skip }: DecidedCell,
  real: ExamplesData,
): Markup {
  const outcome =
    cell.outcome === "written"
      ? "Written"
      : markup`Not written: <code>${cell.outcome}</code>`;
  const panes =
    cell.code && after !== undefined
      ? appliedTo !== undefined
        ? markup`<div class="panes three">
        <figure><figcaption>Run</figcaption><pre><code>${renderCode(cell.code, cell.code)}</code></pre></figure>
        <figure><figcaption>${cell.twice ? "After the first apply" : "Changed before apply"}</figcaption><pre><code>${renderCode(cell.code, appliedTo)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(appliedTo, after)}</code></pre></figure>
      </div>`
        : markup`<div class="panes">
        <figure><figcaption>Before</figcaption><pre><code>${renderCode(cell.code, cell.code)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(cell.code, after)}</code></pre></figure>
      </div>`
      : markup`<p class="note">${prose(cell.unreachable ?? "")}</p>`;
  const saw =
    skip?.observed &&
    markup`<dt>Observed</dt><dd><code>${skip.observed}</code>${skip.detail && markup` · ${skip.detail}`}</dd>`;
  const found = (cell.real ?? []).flatMap((id) => {
    const example = real.examples.find((candidate) => candidate.id === id);
    return example ? [example] : [];
  });
  // A real example left alone lives here, beside its rule; the written ones
  // live on Examples.
  const examples = found
    .filter((example) => example.verdict !== "left")
    .map(
      (example) =>
        markup`<a href="../examples/#${example.id}">${example.title}</a>`,
    );
  const shown = join(
    found
      .filter((example) => example.verdict === "left")
      .map(
        (example) =>
          markup`<details class="real"><summary>In real code: ${example.title}</summary>${renderExampleBody(example, real.sources[example.source]!)}</details>`,
      ),
    "\n",
  );
  const links = [
    markup`<a href="${CORE}/${cell.decidedBy.file}">${cell.decidedBy.file}</a> <code>${cell.decidedBy.symbol}</code>`,
    cell.code && markup`<a href="${TEST}">the test that checks this card</a>`,
    // The playground runs one text, as written, without looking for `this`.
    cell.code &&
      !cell.applyTo &&
      !cell.twice &&
      !cell.implicitThis &&
      markup`<a href="../playground/#code=${encodeURIComponent(cell.code)}">open in the playground</a>`,
  ].filter((link): link is Markup => link instanceof Markup);
  return markup`<article id="${anchor(cell)}" class="example">
      <header>
        <h3><a href="#${anchor(cell)}">${cell.title}</a></h3>
        <p class="meta"><span class="source">${KINDS[cell.kind]}${named(cell) && markup` <code>${cell.name}</code>`}</span> <span>${outcome}</span></p>
      </header>
      ${panes}
      <p class="caption">${prose(cell.why)}</p>
      <dl class="note">
        ${saw}
        <dt>Decided in</dt><dd>${join(links, " · ")}</dd>
        ${examples.length > 0 && markup`<dt>In real code</dt><dd>${join(examples, ", ")}</dd>`}
      </dl>
      ${shown}
    </article>`;
}

/**
 * The matrix's two axes. Kind: one selected, the kind of the card being read.
 * Outcome: every outcome, the ones the selected kind lacks disabled. Rendered
 * with the first kind selected, so the menu reads right before the script runs.
 */
function renderToc(cards: DecidedCell[]): Markup {
  const kinds = [...new Set(cards.map(({ cell }) => cell.kind))];
  const outcomesOf = (kind: SiteKind): Outcome[] =>
    OUTCOMES.filter((o) =>
      cards.some(({ cell }) => cell.kind === kind && cell.outcome === o),
    );
  const first = kinds[0];
  const kindItems = kinds.map(
    (kind) =>
      markup`<li><a href="#${kind}-${outcomesOf(kind)[0]}" data-kind="${kind}" data-outcomes="${outcomesOf(kind).join(" ")}"${kind === first && markup` aria-current="true"`}>${KINDS[kind]}</a></li>`,
  );
  const outcomeItems = OUTCOMES.map((outcome) => {
    const has = first !== undefined && outcomesOf(first).includes(outcome);
    return has
      ? markup`<li><a data-outcome="${outcome}" href="#${first}-${outcome}">${outcome}</a></li>`
      : markup`<li><a data-outcome="${outcome}" aria-disabled="true">${outcome}</a></li>`;
  });
  return markup`<nav class="toc" aria-label="Kinds and outcomes">
  <button type="button" class="toc-toggle" aria-expanded="false" aria-controls="toc-list"><span class="toc-current">Kinds and outcomes</span></button>
  <div id="toc-list" class="toc-list">
    <p class="toc-kind">Kind</p><ul id="kinds">${kindItems}</ul>
    <p class="toc-kind" id="outcome-heading">Outcome${first && markup` — ${KINDS[first]}`}</p><ul id="outcomes">${outcomeItems}</ul>
  </div>
</nav>`;
}

/** A return or `this` has no name of its own beyond the kind. */
const named = (cell: Cell): boolean =>
  cell.name !== "" && cell.kind !== "return" && cell.kind !== "this";

/** Each kind's cards in a section under the kind's name. */
function renderSections(cards: DecidedCell[], real: ExamplesData): Markup {
  const kinds = [...new Set(cards.map(({ cell }) => cell.kind))];
  return join(
    kinds.map(
      (kind) => markup`<section class="kind" id="kind-${kind}">
  <h2 class="kind-heading">${KINDS[kind]}</h2>
${join(
  cards
    .filter(({ cell }) => cell.kind === kind)
    .map((card) => renderCard(card, real)),
  "\n",
)}
</section>`,
    ),
    "\n",
  );
}

/** For each example a card shows, the card that shows the fewest: the most specific. */
export function ruleLinks(cells: Cell[]): Map<string, RuleLink> {
  const best = new Map<string, Cell>();
  for (const cell of cells) {
    for (const id of cell.real ?? []) {
      const current = best.get(id);
      if (!current || cell.real!.length < current.real!.length)
        best.set(id, cell);
    }
  }
  return new Map(
    [...best].map(([id, cell]) => [
      id,
      {
        href: `../how-it-decides/#${anchor(cell)}`,
        label: `${KINDS[cell.kind]} · ${cell.outcome}`,
      },
    ]),
  );
}

/** `real` holds the examples from real runs that the cards point to. */
export function renderDecidesPage(
  given: DecidedCell[],
  real: ExamplesData,
  build: BuildInfo,
): string {
  // Each kind's cards in the order of the outcome list, so the menu and the
  // page agree.
  const kindOrder = [...new Set(given.map(({ cell }) => cell.kind))];
  const cards = [...given].sort(
    (a, b) =>
      kindOrder.indexOf(a.cell.kind) - kindOrder.indexOf(b.cell.kind) ||
      OUTCOMES.indexOf(a.cell.outcome) - OUTCOMES.indexOf(b.cell.outcome),
  );
  return renderLayout(
    {
      id: "how-it-decides",
      title: "How it decides",
      description:
        "Every way ts-capture apply treats a position: what it writes, what it refuses to write, and the code that decides it.",
      top: markup`<h1>How it decides</h1>
  <p class="lede">For every position the tests passed through, <code>apply</code> either writes the type it saw or leaves the position alone, and says why. Each card below is one of those outcomes: a small file, run and applied, and the code that made the call.</p>
  <p class="how">The cards are not written by hand: each is run through the same applier as the playground when the page is built, and a test checks that it still ends where the card says.</p>
  ${renderGrid(cards)}`,
      body: markup`<div class="layout">
${renderToc(cards)}
<main>
${renderSections(cards, real)}
</main>
</div>`,
    },
    build,
  );
}
