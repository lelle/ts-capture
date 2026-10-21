import { escapeHtml, renderCode } from "../code.js";
import {
  type BuildInfo,
  ICON_LINK,
  pageTitle,
  renderSiteBar,
  renderSiteFooter,
  REPO,
} from "../frame.js";
import {
  type ExamplesData,
  renderExampleBody,
  type RuleLink,
} from "../page.js";
import { STYLE } from "../style.js";
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
const prose = (text: string): string =>
  escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

/** What the grid's marks mean, for the marks it has. */
function legend(cards: DecidedCell[]): string {
  const parts = ["● an example you can run"];
  if (cards.some(({ cell }) => !cell.code)) {
    parts.push("○ running code cannot get there; the card says why");
  }
  parts.push("empty: not an outcome for that kind");
  return parts.join(" · ");
}

function renderGrid(cards: DecidedCell[]): string {
  const kinds = [...new Set(cards.map(({ cell }) => cell.kind))];
  const head = OUTCOMES.map(
    (outcome) => `<th scope="col">${escapeHtml(outcome)}</th>`,
  ).join("");
  const rows = kinds.map((kind) => {
    const cells = OUTCOMES.map((outcome: Outcome) => {
      const found = cards.find(
        ({ cell }) => cell.kind === kind && cell.outcome === outcome,
      );
      if (!found) return "<td></td>";
      const cls = found.cell.code ? "" : ' class="unreachable"';
      return `<td${cls}><a href="#${anchor(found.cell)}" title="${escapeHtml(found.cell.title)}">${found.cell.code ? "●" : "○"}</a></td>`;
    }).join("");
    return `<tr><th scope="row">${escapeHtml(KINDS[kind])}</th>${cells}</tr>`;
  });
  return `<div class="grid-scroll"><table class="grid">
  <thead><tr><td></td>${head}</tr></thead>
  <tbody>${rows.join("")}</tbody>
</table></div>
<p class="how">${legend(cards)}</p>`;
}

function renderCard(
  { cell, after, appliedTo, skip }: DecidedCell,
  real: ExamplesData,
): string {
  const outcome =
    cell.outcome === "written"
      ? "Written"
      : `Not written: <code>${escapeHtml(cell.outcome)}</code>`;
  const panes =
    cell.code && after !== undefined
      ? appliedTo !== undefined
        ? `<div class="panes three">
        <figure><figcaption>Run</figcaption><pre><code>${renderCode(cell.code, cell.code)}</code></pre></figure>
        <figure><figcaption>${cell.twice ? "After the first apply" : "Changed before apply"}</figcaption><pre><code>${renderCode(cell.code, appliedTo)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(appliedTo, after)}</code></pre></figure>
      </div>`
        : `<div class="panes">
        <figure><figcaption>Before</figcaption><pre><code>${renderCode(cell.code, cell.code)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(cell.code, after)}</code></pre></figure>
      </div>`
      : `<p class="note">${prose(cell.unreachable ?? "")}</p>`;
  const saw = skip?.observed
    ? `<dt>Observed</dt><dd><code>${escapeHtml(skip.observed)}</code>${skip.detail ? ` · ${escapeHtml(skip.detail)}` : ""}</dd>`
    : "";
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
        `<a href="../examples/#${escapeHtml(example.id)}">${escapeHtml(example.title)}</a>`,
    )
    .join(", ");
  const shown = found
    .filter((example) => example.verdict === "left")
    .map(
      (example) =>
        `<details class="real"><summary>In real code: ${escapeHtml(example.title)}</summary>${renderExampleBody(example, real.sources[example.source]!)}</details>`,
    )
    .join("\n");
  const links = [
    `<a href="${CORE}/${escapeHtml(cell.decidedBy.file)}">${escapeHtml(cell.decidedBy.file)}</a> <code>${escapeHtml(cell.decidedBy.symbol)}</code>`,
    cell.code ? `<a href="${TEST}">the test that checks this card</a>` : "",
    // The playground runs one text, as written, without looking for `this`.
    cell.code && !cell.applyTo && !cell.twice && !cell.implicitThis
      ? `<a href="../playground/#code=${encodeURIComponent(cell.code)}">open in the playground</a>`
      : "",
  ].filter(Boolean);
  return `<article id="${anchor(cell)}" class="example">
      <header>
        <h3><a href="#${anchor(cell)}">${escapeHtml(cell.title)}</a></h3>
        <p class="meta"><span class="source">${escapeHtml(KINDS[cell.kind])}${named(cell) ? ` <code>${escapeHtml(cell.name)}</code>` : ""}</span> <span>${outcome}</span></p>
      </header>
      ${panes}
      <p class="caption">${prose(cell.why)}</p>
      <dl class="note">
        ${saw}
        <dt>Decided in</dt><dd>${links.join(" · ")}</dd>
        ${examples ? `<dt>In real code</dt><dd>${examples}</dd>` : ""}
      </dl>
      ${shown}
    </article>`;
}

const GRID_STYLE = `
.panes.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 760px) { .panes.three { grid-template-columns: minmax(0, 1fr); } }
.grid-scroll { overflow-x: auto; }
.grid { border-collapse: collapse; font-size: 0.85rem; }
.grid th, .grid td { padding: 0.35rem 0.5rem; text-align: center; }
.grid thead th { font-weight: 500; font-family: ui-monospace, monospace; writing-mode: vertical-rl; transform: rotate(180deg); }
.grid tbody th { text-align: left; }
.grid a { text-decoration: none; }
.grid .unreachable a { opacity: 0.6; }
`;

/**
 * The matrix's two axes. Kind: one selected, the kind of the card being read.
 * Outcome: every outcome, the ones the selected kind lacks disabled. Rendered
 * with the first kind selected, so the menu reads right before the script runs.
 */
function renderToc(cards: DecidedCell[]): string {
  const kinds = [...new Set(cards.map(({ cell }) => cell.kind))];
  const outcomesOf = (kind: SiteKind): Outcome[] =>
    OUTCOMES.filter((o) =>
      cards.some(({ cell }) => cell.kind === kind && cell.outcome === o),
    );
  const first = kinds[0];
  const kindItems = kinds
    .map(
      (kind) =>
        `<li><a href="#${kind}-${outcomesOf(kind)[0]}" data-kind="${kind}" data-outcomes="${outcomesOf(kind).join(" ")}"${kind === first ? ' aria-current="true"' : ""}>${escapeHtml(KINDS[kind])}</a></li>`,
    )
    .join("");
  const outcomeItems = OUTCOMES.map((outcome) => {
    const has = first !== undefined && outcomesOf(first).includes(outcome);
    return has
      ? `<li><a data-outcome="${outcome}" href="#${first}-${outcome}">${escapeHtml(outcome)}</a></li>`
      : `<li><a data-outcome="${outcome}" aria-disabled="true">${escapeHtml(outcome)}</a></li>`;
  }).join("");
  return `<nav class="toc" aria-label="Kinds and outcomes">
  <button type="button" class="toc-toggle" aria-expanded="false" aria-controls="toc-list"><span class="toc-current">Kinds and outcomes</span></button>
  <div id="toc-list" class="toc-list">
    <p class="toc-kind">Kind</p><ul id="kinds">${kindItems}</ul>
    <p class="toc-kind" id="outcome-heading">Outcome${first ? ` — ${escapeHtml(KINDS[first])}` : ""}</p><ul id="outcomes">${outcomeItems}</ul>
  </div>
</nav>`;
}

const TOC_STYLE = `
.layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 0 44px; max-width: 1180px; margin: 0 auto; padding: 0 20px; }
.layout main { max-width: none; margin: 0; padding: 0; min-width: 0; }
.toc { position: sticky; top: 0; align-self: start; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; border-right: 1px solid var(--line); font-size: 13px; }
.toc-toggle { display: none; }
.toc-list { overflow-y: auto; padding: 24px 12px 24px 0; }
.toc-kind { margin: 18px 0 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.toc-kind:first-child { margin-top: 0; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc a { display: block; padding: 1px 8px; border-left: 2px solid transparent; color: var(--muted); text-decoration: none; font-family: ui-monospace, monospace; cursor: pointer; }
.toc a:hover { color: var(--text); }
#kinds a[aria-current] { color: var(--text); font-weight: 600; border-left-color: var(--accent); }
#kinds a[aria-current]::before { content: "◉ "; color: var(--accent); }
#outcomes a.on-screen { color: var(--text); border-left-color: var(--accent); background: var(--code-bg); }
#outcomes a[aria-disabled="true"] { opacity: 0.4; text-decoration: line-through; cursor: default; pointer-events: none; }
@media (max-width: 900px) {
  .layout { display: block; padding: 0; }
  .layout main { padding: 0 20px; }
  .toc { z-index: 2; height: auto; border-right: 0; border-bottom: 1px solid var(--line); background: var(--bg); }
  .toc-toggle { display: block; width: 100%; padding: 10px 20px; text-align: left; font: inherit; color: var(--text); background: var(--bg); border: 0; cursor: pointer; }
  .toc-toggle::after { content: " ▾"; color: var(--muted); }
  .toc-list { display: none; max-height: 60vh; padding-top: 4px; }
  .toc.open .toc-list { display: block; }
  .example { scroll-margin-top: 48px; }
}
`;

/** A return or `this` has no name of its own beyond the kind. */
const named = (cell: Cell): boolean =>
  cell.name !== "" && cell.kind !== "return" && cell.kind !== "this";

/** Each kind's cards in a section under the kind's name. */
function renderSections(cards: DecidedCell[], real: ExamplesData): string {
  const kinds = [...new Set(cards.map(({ cell }) => cell.kind))];
  return kinds
    .map(
      (kind) => `<section class="kind" id="kind-${kind}">
  <h2 class="kind-heading">${escapeHtml(KINDS[kind])}</h2>
${cards
  .filter(({ cell }) => cell.kind === kind)
  .map((card) => renderCard(card, real))
  .join("\n")}
</section>`,
    )
    .join("\n");
}

const SECTION_STYLE = `
.kind { padding-top: 56px; }
.kind:first-child { padding-top: 32px; }
.kind-heading { margin: 0 0 18px; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.kind .example { scroll-margin-top: 16px; }
.real { margin: 18px 0 0; padding-top: 14px; border-top: 1px solid var(--line); }
.real summary { cursor: pointer; font-weight: 600; margin: 0 0 12px; }
@media (max-width: 900px) { .kind .example { scroll-margin-top: 56px; } }
`;

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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ICON_LINK}
<title>${pageTitle("How it decides")}</title>
<meta name="description" content="Every way ts-capture apply treats a position: what it writes, what it refuses to write, and the code that decides it.">
<style>${STYLE}${GRID_STYLE}${TOC_STYLE}${SECTION_STYLE}</style>
</head>
<body>
<div class="top">
  ${renderSiteBar("how-it-decides")}
  <h1>How it decides</h1>
  <p class="lede">For every position the tests passed through, <code>apply</code> either writes the type it saw or leaves the position alone, and says why. Each card below is one of those outcomes: a small file, run and applied, and the code that made the call.</p>
  <p class="how">The cards are not written by hand: each is run through the same applier as the playground when the page is built, and a test checks that it still ends where the card says.</p>
  ${renderGrid(cards)}
</div>
<div class="layout">
${renderToc(cards)}
<main>
${renderSections(cards, real)}
</main>
</div>
${renderSiteFooter(build, "how-it-decides")}
<script type="module" src="../js/how-it-decides.js"></script>
</body>
</html>
`;
}
