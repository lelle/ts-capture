import type { Starter } from "./starters.js";

import { escapeHtml } from "../code.js";
import {
  type BuildInfo,
  pageTitle,
  renderSiteBar,
  renderSiteFooter,
} from "../frame.js";
import { STYLE } from "../style.js";

/** JSON that can sit inside a `script` element: no `<` to end the element with. */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function renderPlaygroundPage(
  starters: Starter[],
  build: BuildInfo,
): string {
  const options = starters
    .map(
      (starter) =>
        `<option value="${escapeHtml(starter.id)}">${escapeHtml(starter.title)}</option>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle("Playground")}</title>
<meta name="description" content="Run ts-capture in your browser: write untyped TypeScript, call it, and see the types it observed written back.">
<style>${STYLE}</style>
</head>
<body>
<div class="top">
  ${renderSiteBar("playground")}
  <h1>Playground</h1>
  <p class="lede">Write untyped TypeScript, call it at the end of the file, and run. ts-capture watches the calls and writes the types it saw back into the code.</p>
  <p class="how">Everything happens in this tab: the code runs in your browser and is sent nowhere. The calls play the part your test suite plays in a real project.</p>
</div>
<main>
  <noscript><p class="empty">The playground needs JavaScript. The <a href="../examples/">examples</a> do not.</p></noscript>
  <div class="controls">
    <label for="starter">Start from</label>
    <select id="starter">${options}</select>
    <button type="button" id="run">Run</button>
    <span class="status" id="status" role="status"></span>
  </div>
  <div class="panes playground">
    <figure><figcaption><label for="code">Your code</label></figcaption><textarea id="code" spellcheck="false" autocapitalize="off" autocomplete="off">${escapeHtml(starters[0].code)}</textarea></figure>
    <figure class="result"><figcaption>After <code>ts-capture apply</code></figcaption><pre><code id="result"></code></pre></figure>
  </div>
  <div class="outcome"><pre id="report"></pre></div>
  <ul class="limits">
    <li>One file, no imports, and only the JavaScript standard library: no DOM and no Node.</li>
    <li>An annotation that would not compile is not written. The report under the result says which, and why.</li>
    <li>A type is only as good as the calls behind it. See <a href="../docs/explanation/what-it-cannot-infer/">what it cannot infer</a>.</li>
    <li>This runs the same applier and type-check as the <code>ts-capture</code> CLI. A real project also gets its test runner, several files and its own <code>tsconfig.json</code>.</li>
  </ul>
</main>
${renderSiteFooter(build, "playground")}
<script type="application/json" id="starters">${embeddedJson(starters)}</script>
<script type="module" src="main.js"></script>
</body>
</html>
`;
}
