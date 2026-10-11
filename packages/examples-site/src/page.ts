import { markAdded, tokenize } from "./tokens.js";

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

const ENTITIES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeHtml(text: string): string {
  return text.replaceAll(/["&'<>]/g, (character) => ENTITIES[character]);
}

/** `after` as highlighted HTML, with what `before` does not have wrapped in `ins`. */
export function renderCode(before: string, after: string): string {
  let html = "";
  let inAdded = false;
  for (const token of markAdded(tokenize(before), tokenize(after))) {
    if (token.added !== inAdded) {
      html += token.added ? "<ins>" : "</ins>";
      inAdded = token.added;
    }
    const text = escapeHtml(token.text);
    html +=
      token.kind === "space" || token.kind === "punctuation"
        ? text
        : `<span class="t-${token.kind}">${text}</span>`;
  }
  return inAdded ? `${html}</ins>` : html;
}

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

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf7; --surface: #ffffff; --text: #1d1c1a; --muted: #6b675f; --line: #e4e0d8;
  --code-bg: #f6f4ef; --accent: #1f5fbf;
  --add-bg: #c9eed1;
  --good: #1f7a3a; --weak: #a55b00; --left: #5b5fb0;
  --kw: #8a2f8f; --type: #0b6e8a; --str: #9a4a12; --num: #1a6b52; --com: #7b776e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161a; --surface: #1c1e24; --text: #e9e7e2; --muted: #9c988f; --line: #2c2f38;
    --code-bg: #121318; --accent: #8fb8ff;
    --add-bg: #1f5230;
    --good: #6fd08a; --weak: #f0b35a; --left: #a9adf5;
    --kw: #d691da; --type: #6fc7e0; --str: #e8a878; --num: #86d6b8; --com: #8a8780;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main, .top, footer { max-width: 1180px; margin: 0 auto; padding: 0 20px; }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.top { padding-top: 44px; padding-bottom: 8px; }
.top p.links { margin: 0 0 28px; font-size: 14px; }
.top p.links a { margin-right: 16px; }
h1 { font-size: clamp(28px, 4.5vw, 42px); line-height: 1.15; margin: 0 0 14px; letter-spacing: -0.01em; text-wrap: balance; }
.lede { font-size: 18px; max-width: 68ch; margin: 0 0 12px; }
.how { color: var(--muted); max-width: 68ch; margin: 0 0 8px; }
.filters { display: flex; flex-wrap: wrap; gap: 10px 24px; padding: 18px 0 6px; position: sticky; top: 0; background: var(--bg); z-index: 1; border-bottom: 1px solid var(--line); }
.filters div { display: flex; flex-wrap: wrap; gap: 6px; }
.filters button {
  font: inherit; font-size: 14px; padding: 5px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--text);
}
.filters button[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }
.filters button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.example { padding: 34px 0 30px; border-bottom: 1px solid var(--line); }
.example[hidden] { display: none; }
.example h2 { font-size: 21px; line-height: 1.3; margin: 0 0 8px; text-wrap: balance; }
.example h2 a { color: inherit; text-decoration: none; }
.example h2 a:hover { text-decoration: underline; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 0 0 16px; font-size: 14px; color: var(--muted); }
.verdict { font-weight: 600; padding: 1px 9px; border-radius: 999px; border: 1px solid currentColor; }
.verdict-good { color: var(--good); } .verdict-weak { color: var(--weak); } .verdict-left { color: var(--left); }
.file { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.panes { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
figure { margin: 0; min-width: 0; }
figcaption { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 6px; }
figcaption code { text-transform: none; letter-spacing: 0; font-size: 12px; }
pre {
  margin: 0; padding: 14px 16px; background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
  font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2;
}
ins { text-decoration: none; background: var(--add-bg); border-radius: 3px; padding: 1px 0; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.t-keyword { color: var(--kw); } .t-type { color: var(--type); } .t-string { color: var(--str); }
.t-number { color: var(--num); } .t-comment { color: var(--com); font-style: italic; }
.caption { max-width: 76ch; margin: 16px 0 0; }
.note { max-width: 76ch; margin: 12px 0 0; padding: 10px 14px; border-left: 3px solid var(--line); background: var(--surface); font-size: 15px; }
.note code { font-size: 13.5px; overflow-wrap: anywhere; }
.better { border-left-color: var(--weak); }
.note-label, .left-alone dt { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.left-alone { border-left-color: var(--left); display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; }
.left-alone dd { margin: 0; overflow-wrap: anywhere; }
.empty { padding: 30px 0; color: var(--muted); }
footer { padding-top: 30px; padding-bottom: 60px; color: var(--muted); font-size: 14.5px; }
footer h2 { font-size: 16px; color: var(--text); margin: 0 0 8px; }
footer ul { padding-left: 18px; margin: 0 0 14px; }
footer li { margin-bottom: 6px; max-width: 86ch; }
footer code { font-size: 13px; }
@media (max-width: 760px) {
  .panes { grid-template-columns: minmax(0, 1fr); }
  .top { padding-top: 28px; }
  pre { font-size: 12.5px; padding: 12px; }
}
`;

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

export function renderPage(data: ExamplesData): string {
  const examples = data.examples
    .map((example) => renderExample(example, data.sources[example.source]))
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ts-capture — what it writes</title>
<meta name="description" content="Before and after: what ts-capture wrote into real code, including the results a reviewer should change.">
<style>${STYLE}</style>
</head>
<body>
<div class="top">
  <p class="links"><a href="https://github.com/lelle/ts-capture">ts-capture on GitHub</a><a href="https://github.com/lelle/ts-capture/tree/main/docs">Documentation</a></p>
  <h1>What ts-capture writes</h1>
  <p class="lede">ts-capture watches your code run under its tests and writes the types it saw back into the source. These are annotations it wrote into real code: the ones you would have written yourself, the ones a reviewer should change, and the places it chose to leave alone.</p>
  <p class="how">Nothing here was typed by hand. Each example is cut from the diff of an actual run; the highlighted parts are what <code>apply</code> added.</p>
  ${renderFilters(data)}
</div>
<main>
${examples}
<p class="empty" hidden>No example matches both filters.</p>
</main>
<footer>
  <h2>Where these come from</h2>
  <ul>
${renderSources(data)}
  </ul>
  <p>A type is only as good as what the tests passed in. The examples marked “needs review” are not bugs: they describe the test run exactly, which is why nothing flags them. See <a href="https://github.com/lelle/ts-capture/blob/main/docs/explanation/what-it-cannot-infer.md">what it cannot infer</a> and <a href="https://github.com/lelle/ts-capture/blob/main/docs/how-to/review-and-apply-safely.md">review and apply safely</a>.</p>
</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
