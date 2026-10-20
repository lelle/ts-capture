import { escapeHtml, renderCode } from "../code.js";
import { STYLE } from "../style.js";
import { type Cell, type Outcome, OUTCOMES, type SiteKind } from "./cells.js";

/** A cell, run: what apply wrote, and what it said where it wrote nothing. */
export interface DecidedCell {
  cell: Cell;
  after?: string;
  skip?: { observed: string | undefined; detail: string | undefined };
}

const REPO = "https://github.com/lelle/ts-capture";
const CORE = `${REPO}/blob/main/packages/core/src`;
const TEST = `${REPO}/blob/main/packages/examples-site/src/how-it-decides/cells.spec.ts`;

const KINDS: Record<SiteKind, string> = {
  parameter: "Parameter",
  return: "Return type",
  variable: "Variable",
};

const anchor = (cell: Cell): string => `${cell.kind}-${cell.outcome}`;

/** Escaped prose, with what it quotes in backticks set as code. */
const prose = (text: string): string =>
  escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

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
<p class="how">● an example you can run · ○ running code cannot get there; the card says why.</p>`;
}

function renderCard(
  { cell, after, skip }: DecidedCell,
  real: ReadonlyMap<string, string>,
): string {
  const outcome =
    cell.outcome === "written"
      ? "Written"
      : `Not written: <code>${escapeHtml(cell.outcome)}</code>`;
  const panes =
    cell.code && after !== undefined
      ? `<div class="panes">
        <figure><figcaption>Before</figcaption><pre><code>${renderCode(cell.code, cell.code)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(cell.code, after)}</code></pre></figure>
      </div>`
      : `<p class="note">${prose(cell.unreachable ?? "")}</p>`;
  const saw = skip?.observed
    ? `<dt>Observed</dt><dd><code>${escapeHtml(skip.observed)}</code>${skip.detail ? ` · ${escapeHtml(skip.detail)}` : ""}</dd>`
    : "";
  const examples = (cell.real ?? [])
    .map(
      (id) =>
        `<a href="../examples/#${escapeHtml(id)}">${escapeHtml(real.get(id) ?? id)}</a>`,
    )
    .join(", ");
  const links = [
    `<a href="${CORE}/${escapeHtml(cell.decidedBy.file)}">${escapeHtml(cell.decidedBy.file)}</a> <code>${escapeHtml(cell.decidedBy.symbol)}</code>`,
    cell.code ? `<a href="${TEST}">the test that checks this card</a>` : "",
    cell.code
      ? `<a href="../playground/#code=${encodeURIComponent(cell.code)}">open in the playground</a>`
      : "",
  ].filter(Boolean);
  return `<article id="${anchor(cell)}" class="example">
      <header>
        <h2><a href="#${anchor(cell)}">${escapeHtml(cell.title)}</a></h2>
        <p class="meta"><span class="source">${escapeHtml(KINDS[cell.kind])}${cell.name ? ` <code>${escapeHtml(cell.name)}</code>` : ""}</span> <span>${outcome}</span></p>
      </header>
      ${panes}
      <p class="caption">${prose(cell.why)}</p>
      <dl class="note">
        ${saw}
        <dt>Decided in</dt><dd>${links.join(" · ")}</dd>
        ${examples ? `<dt>In real code</dt><dd>${examples}</dd>` : ""}
      </dl>
    </article>`;
}

const GRID_STYLE = `
.grid-scroll { overflow-x: auto; }
.grid { border-collapse: collapse; font-size: 0.85rem; }
.grid th, .grid td { padding: 0.35rem 0.5rem; text-align: center; }
.grid thead th { font-weight: 500; font-family: ui-monospace, monospace; writing-mode: vertical-rl; transform: rotate(180deg); }
.grid tbody th { text-align: left; }
.grid a { text-decoration: none; }
.grid .unreachable a { opacity: 0.6; }
`;

/** `real` maps a real example's id to its title. */
export function renderDecidesPage(
  cards: DecidedCell[],
  real: ReadonlyMap<string, string>,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ts-capture — how it decides</title>
<meta name="description" content="Every way ts-capture apply treats a position: what it writes, what it refuses to write, and the code that decides it.">
<style>${STYLE}${GRID_STYLE}</style>
</head>
<body>
<div class="top">
  <p class="links"><a href="../">ts-capture</a><a href="../examples/">Examples</a><a href="../playground/">Playground</a><a href="${REPO}">ts-capture on GitHub</a></p>
  <h1>How it decides</h1>
  <p class="lede">For every position the tests passed through, <code>apply</code> either writes the type it saw or leaves the position alone, and says why. Each card below is one of those outcomes: a small file, run and applied, and the code that made the call.</p>
  <p class="how">The cards are not written by hand: each is run through the same applier as the playground when the page is built, and a test checks that it still ends where the card says.</p>
  ${renderGrid(cards)}
</div>
<main>
${cards.map((card) => renderCard(card, real)).join("\n")}
</main>
</body>
</html>
`;
}
