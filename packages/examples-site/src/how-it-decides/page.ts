import { escapeHtml, renderCode } from "../code.js";
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

const REPO = "https://github.com/lelle/ts-capture";
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
  real: ReadonlyMap<string, string>,
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
  const examples = (cell.real ?? [])
    .map(
      (id) =>
        `<a href="../examples/#${escapeHtml(id)}">${escapeHtml(real.get(id) ?? id)}</a>`,
    )
    .join(", ");
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

/** Every card, under its kind, in page order. */
function renderToc(cards: DecidedCell[]): string {
  const kinds = [...new Set(cards.map(({ cell }) => cell.kind))];
  const groups = kinds.map((kind) => {
    const items = cards
      .filter(({ cell }) => cell.kind === kind)
      .map(
        ({ cell }) =>
          `<li><a href="#${anchor(cell)}" data-label="${escapeHtml(`${KINDS[kind]} · ${cell.outcome}`)}">${escapeHtml(cell.outcome)}</a></li>`,
      )
      .join("");
    return `<p class="toc-kind">${escapeHtml(KINDS[kind])}</p><ul>${items}</ul>`;
  });
  return `<nav class="toc" aria-label="Cards">
  <button type="button" class="toc-toggle" aria-expanded="false" aria-controls="toc-list"><span class="toc-current">Cards</span></button>
  <div id="toc-list" class="toc-list">${groups.join("")}</div>
</nav>`;
}

// Marks in the menu every card on screen, and keeps the first of them in
// view inside the menu without moving the page. On a narrow screen the menu
// folds behind a button that names where the reader is.
const TOC_SCRIPT = `
const toc = document.querySelector(".toc");
const toggle = toc.querySelector(".toc-toggle");
const current = toc.querySelector(".toc-current");
const list = document.getElementById("toc-list");
const links = new Map([...list.querySelectorAll("a")].map((a) => [a.getAttribute("href").slice(1), a]));
const fold = (open) => {
  toggle.setAttribute("aria-expanded", String(open));
  toc.classList.toggle("open", open);
};
toggle.addEventListener("click", () => fold(toggle.getAttribute("aria-expanded") !== "true"));
list.addEventListener("click", (event) => {
  if (event.target.closest("a")) fold(false);
});
// On a narrow screen the folded menu is a bar over the top of the page: what
// is under it is not on screen.
const bar = getComputedStyle(toggle).display === "none" ? 0 : toc.offsetHeight;
// The observer only says which cards are near the screen. Whether one shows
// more than a sliver is measured from where it is now, every frame the page
// scrolls: an observer reports a card once, as it crosses the edge, and a card
// that crossed by two pixels during a fast scroll would never count.
const near = new Set();
const update = () => {
  const onScreen = new Set();
  for (const id of near) {
    const r = document.getElementById(id).getBoundingClientRect();
    if (Math.min(r.bottom, innerHeight) - Math.max(r.top, bar) > 4) onScreen.add(id);
  }
  for (const [id, link] of links) link.classList.toggle("on-screen", onScreen.has(id));
  // The card being read: the first one on screen with more than a sliver of it
  // left above the fold.
  const shown = [...links.keys()].filter((id) => onScreen.has(id));
  const reading =
    shown.find((id) => document.getElementById(id).getBoundingClientRect().bottom > bar + 80) ??
    shown[0];
  if (!reading) return;
  const link = links.get(reading);
  current.textContent = link.dataset.label;
  const top = link.offsetTop;
  if (top < list.scrollTop || top + link.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = top - list.clientHeight / 3;
  }
};
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) near.add(entry.target.id);
    else near.delete(entry.target.id);
  }
  update();
});
let frame = 0;
addEventListener(
  "scroll",
  () => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  },
  { passive: true },
);
for (const id of links.keys()) {
  const card = document.getElementById(id);
  if (card) observer.observe(card);
}
`;

const TOC_STYLE = `
.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); }
.toc { position: sticky; top: 0; align-self: start; max-height: 100vh; display: flex; flex-direction: column; border-right: 1px solid var(--line); font-size: 13px; }
.toc-toggle { display: none; }
.toc-list { position: relative; overflow-y: auto; padding: 24px 12px 24px 20px; }
.toc-kind { margin: 14px 0 4px; font-weight: 600; }
.toc-kind:first-child { margin-top: 0; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc a { display: block; padding: 1px 8px; border-left: 2px solid transparent; color: var(--muted); text-decoration: none; font-family: ui-monospace, monospace; }
.toc a:hover { color: var(--text); }
.toc a.on-screen { color: var(--text); border-left-color: var(--accent); background: var(--code-bg); }
@media (max-width: 900px) {
  .layout { display: block; }
  .toc { z-index: 2; max-height: none; border-right: 0; border-bottom: 1px solid var(--line); background: var(--bg); }
  .toc-toggle { display: block; width: 100%; padding: 10px 20px; text-align: left; font: inherit; color: var(--text); background: var(--bg); border: 0; cursor: pointer; }
  .toc-toggle::after { content: " ▾"; color: var(--muted); }
  .toc-list { display: none; max-height: 60vh; padding-top: 4px; }
  .toc.open .toc-list { display: block; }
  .example { scroll-margin-top: 48px; }
}
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
<style>${STYLE}${GRID_STYLE}${TOC_STYLE}</style>
</head>
<body>
<div class="layout">
${renderToc(cards)}
<div class="content">
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
</div>
</div>
<script>${TOC_SCRIPT}</script>
</body>
</html>
`;
}
