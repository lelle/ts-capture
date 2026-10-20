import { escapeHtml, renderCode } from "./code.js";
import {
  type BuildInfo,
  pageTitle,
  renderSiteBar,
  renderSiteFooter,
} from "./frame.js";
import { STYLE } from "./style.js";

export interface ExampleSource {
  about: string;
  commit: string;
  name: string;
  tsCapture: string;
  url: null | string;
}

export interface LeftAlone {
  group: string;
  name: string;
  observed: null | string;
  position: string;
  reason: null | string;
}

export interface Example {
  after: string;
  before: string;
  better?: string;
  caption: string;
  file: string;
  id: string;
  leftAlone?: LeftAlone;
  line: number;
  source: string;
  title: string;
  verdict: "good" | "left" | "weak";
}

export interface ExamplesData {
  examples: Example[];
  sources: Record<string, ExampleSource>;
}

const VERDICTS: Record<Example["verdict"], { label: string; summary: string }> =
  {
    good: { label: "Good", summary: "what you would have written" },
    left: {
      label: "Left alone",
      summary: "observed, and deliberately not written",
    },
    weak: {
      label: "Needs review",
      summary: "accurate about the test run, wrong as a type",
    },
  };

const VERDICT_ORDER: Example["verdict"][] = ["good", "weak", "left"];

function fileReference(example: Example, source: ExampleSource): string {
  const place = `${escapeHtml(example.file)}:${example.line}`;
  if (!source.url) return `<span class="file">${place}</span>`;
  const href = `${source.url}/blob/${source.commit}/${example.file}#L${example.line}`;
  return `<a class="file" href="${escapeHtml(href)}">${place}</a>`;
}

function renderExample(example: Example, source: ExampleSource): string {
  const verdict = VERDICTS[example.verdict];
  const better = example.better
    ? `<p class="note better"><span class="note-label">A reviewer would write</span> <code>${escapeHtml(example.better)}</code></p>`
    : "";
  const left = example.leftAlone
    ? `<dl class="note left-alone">
        <dt>Not written</dt><dd><code>${escapeHtml(example.leftAlone.name)}</code> · ${escapeHtml(example.leftAlone.group.toLowerCase())}</dd>
        ${example.leftAlone.observed ? `<dt>Observed</dt><dd><code>${escapeHtml(example.leftAlone.observed)}</code></dd>` : ""}
        ${example.leftAlone.reason ? `<dt>Why</dt><dd>${escapeHtml(example.leftAlone.reason)}</dd>` : ""}
      </dl>`
    : "";
  return `<article id="${escapeHtml(example.id)}" class="example" data-source="${escapeHtml(example.source)}" data-verdict="${example.verdict}">
      <header>
        <h2><a href="#${escapeHtml(example.id)}">${escapeHtml(example.title)}</a></h2>
        <p class="meta">
          <span class="verdict verdict-${example.verdict}" title="${escapeHtml(verdict.summary)}">${verdict.label}</span>
          <span class="source">${escapeHtml(source.name)}</span>
          ${fileReference(example, source)}
        </p>
      </header>
      <div class="panes">
        <figure><figcaption>Before</figcaption><pre><code>${renderCode(example.before, example.before)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(example.before, example.after)}</code></pre></figure>
      </div>
      <p class="caption">${escapeHtml(example.caption)}</p>
      ${better}${left}
    </article>`;
}

function renderSources(data: ExamplesData): string {
  return Object.entries(data.sources)
    .map(([id, source]) => {
      const count = data.examples.filter(
        (example) => example.source === id,
      ).length;
      const name = source.url
        ? `<a href="${escapeHtml(source.url)}">${escapeHtml(source.name)}</a>`
        : escapeHtml(source.name);
      return `<li><strong>${name}</strong> at <code>${escapeHtml(source.commit)}</code>, ts-capture <code>${escapeHtml(source.tsCapture)}</code>, ${count} example${count === 1 ? "" : "s"}. ${escapeHtml(source.about)}</li>`;
    })
    .join("\n");
}

function renderFilters(data: ExamplesData): string {
  const button = (
    group: string,
    value: string,
    label: string,
    pressed = false,
  ) =>
    `<button type="button" data-filter="${group}" data-value="${escapeHtml(value)}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`;
  const sources = Object.entries(data.sources)
    .map(([id, source]) => button("source", id, source.name))
    .join("");
  const verdicts = VERDICT_ORDER.filter((verdict) =>
    data.examples.some((example) => example.verdict === verdict),
  )
    .map((verdict) => button("verdict", verdict, VERDICTS[verdict].label))
    .join("");
  return `<nav class="filters" aria-label="Filter examples" hidden>
      <div role="group" aria-label="Project">${button("source", "", "All projects", true)}${sources}</div>
      <div role="group" aria-label="Result">${button("verdict", "", "All results", true)}${verdicts}</div>
    </nav>`;
}

const SCRIPT = `
const state = { source: "", verdict: "" };
const nav = document.querySelector(".filters");
const examples = [...document.querySelectorAll(".example")];
const empty = document.querySelector(".empty");
nav.hidden = false;
nav.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state[button.dataset.filter] = button.dataset.value;
  for (const other of nav.querySelectorAll('button[data-filter="' + button.dataset.filter + '"]')) {
    other.setAttribute("aria-pressed", String(other === button));
  }
  let shown = 0;
  for (const example of examples) {
    const visible =
      (!state.source || example.dataset.source === state.source) &&
      (!state.verdict || example.dataset.verdict === state.verdict);
    example.hidden = !visible;
    if (visible) shown += 1;
  }
  empty.hidden = shown > 0;
});
`;

export function renderPage(data: ExamplesData, build: BuildInfo): string {
  const examples = data.examples
    .map((example) => renderExample(example, data.sources[example.source]))
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle("Examples")}</title>
<meta name="description" content="Before and after: what ts-capture wrote into real code, including the results a reviewer should change.">
<style>${STYLE}</style>
</head>
<body>
<div class="top">
  ${renderSiteBar("examples")}
  <h1>Examples</h1>
  <p class="lede">ts-capture watches your code run under its tests and writes the types it saw back into the source. These are annotations it wrote into real code: the ones you would have written yourself, the ones a reviewer should change, and the places it chose to leave alone.</p>
  <p class="how">Nothing here was typed by hand. Each example is cut from the diff of an actual run; the highlighted parts are what <code>apply</code> added.</p>
  ${renderFilters(data)}
</div>
<main>
${examples}
<p class="empty" hidden>No example matches both filters.</p>
<section class="sources">
  <h2>Where these come from</h2>
  <ul>
${renderSources(data)}
  </ul>
  <p>A type is only as good as what the tests passed in. The examples marked “needs review” are not bugs: they describe the test run exactly, which is why nothing flags them. See <a href="../docs/explanation/what-it-cannot-infer/">what it cannot infer</a> and <a href="../docs/how-to/review-and-apply-safely/">review and apply safely</a>.</p>
</section>
</main>
${renderSiteFooter(build, "examples")}
<script>${SCRIPT}</script>
</body>
</html>
`;
}
