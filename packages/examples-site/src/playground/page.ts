import type { Kind, Starter } from "./starters.js";

import { type BuildInfo, renderLayout } from "../layout.js";
import { type Markup, markup, trusted } from "../markup.js";
import {
  changedOptions,
  changedSummary,
  OPTION_DEFAULTS,
  OUTPUT_MODES,
  type PlaygroundOptions,
  SWITCHES,
} from "./options.js";

const REFERENCE = "../docs/reference/configuration/#infer";

const configKey = (key: keyof PlaygroundOptions): Markup =>
  markup`<a href="${REFERENCE}"><code>infer.${key}</code></a>`;

function renderOptions(options: PlaygroundOptions): Markup {
  const switches = SWITCHES.map(
    ({ key, label, note }) =>
      markup`<li><input type="checkbox" id="infer-${key}"${options[key] && markup` checked`}> <label for="infer-${key}">${label}</label> ${configKey(key)}${note && markup` <span class="hint">${note}</span>`}</li>`,
  );
  const modes = OUTPUT_MODES.map(
    (mode) =>
      markup`<input type="radio" name="outputMode" id="output-${mode}" value="${mode}"${options.outputMode === mode && markup` checked`}> <label for="output-${mode}">${mode}</label>`,
  );
  const changed = Object.keys(changedOptions(options)).length;
  return markup`<details class="options">
    <summary>Options <span id="changed">${changedSummary(changed)}</span></summary>
    <ul>
      ${switches}
      <li><fieldset><legend>Output</legend> ${modes}</fieldset> ${configKey("outputMode")}</li>
    </ul>
  </details>`;
}

/** JSON that can sit inside a `script` element: no `<` to end the element with. */
function embeddedJson(value: unknown): Markup {
  return trusted(JSON.stringify(value).replaceAll("<", "\\u003c"));
}

/** Marks words for one kind of starter, hidden unless it is the first starter's. */
const kindAttribute = (kind: Kind, first: Kind): Markup =>
  trusted(` data-kind="${kind}"${kind === first ? "" : " hidden"}`);

/** The same words for each kind of starter, only the first starter's kind shown. */
function forEachKind(
  first: Kind,
  render: (kind: Kind, shown: Markup) => Markup,
): Markup[] {
  return (["code", "json"] as const).map((kind) =>
    render(kind, kindAttribute(kind, first)),
  );
}

const CODE_CAPTION: Record<Kind, Markup> = {
  code: markup`Your code`,
  json: markup`Your JSON`,
};

const RESULT_CAPTION: Record<Kind, Markup> = {
  code: markup`After <code>ts-capture apply</code>`,
  json: markup`The type <code>ts-capture apply</code> would write`,
};

export function renderPlaygroundPage(
  starters: Starter[],
  build: BuildInfo,
): string {
  const options = starters.map(
    (starter) =>
      markup`<option value="${starter.id}">${starter.title}</option>`,
  );
  const first = starters[0]?.kind ?? "code";
  const jsonFields = markup`<span class="json-fields"${kindAttribute("json", first)}>
      <label for="root-name">Name</label>
      <input id="root-name" size="10" placeholder="data" spellcheck="false" autocapitalize="off" autocomplete="off">
      <label for="max-depth">Depth</label>
      <input id="max-depth" type="number" min="1" max="20" placeholder="5">
    </span>`;
  const intro = forEachKind(first, (kind, shown) =>
    kind === "code"
      ? markup`<div${shown}>
  <p class="lede">Write untyped TypeScript, call it at the end of the file, and run. ts-capture watches the calls and writes the types it saw back into the code.</p>
  <p class="how">Everything happens in this tab: the code runs in your browser and is sent nowhere. The calls play the part your test suite plays in a real project.</p>
  </div>`
      : markup`<div${shown}>
  <p class="lede">Paste a JSON value and run. ts-capture types it the way <code>apply</code> would type a parameter called with it.</p>
  <p class="how">Everything happens in this tab: the JSON is parsed in your browser and is sent nowhere. In code, <a href="../docs/how-to/type-a-value/"><code>typesFromValues</code></a> does the same for any value.</p>
  </div>`,
  );
  const codeCaption = forEachKind(
    first,
    (kind, shown) => markup`<span${shown}>${CODE_CAPTION[kind]}</span>`,
  );
  const resultCaption = forEachKind(
    first,
    (kind, shown) => markup`<span${shown}>${RESULT_CAPTION[kind]}</span>`,
  );
  const limits = forEachKind(first, (kind, shown) =>
    kind === "code"
      ? markup`<ul class="limits"${shown}>
    <li>One file, no imports, and only the JavaScript standard library: no DOM and no Node.</li>
    <li>An annotation that would not compile is not written. The report under the result says which, and why.</li>
    <li>A type is only as good as the calls behind it. See <a href="../docs/explanation/what-it-cannot-infer/">what it cannot infer</a>.</li>
    <li>This runs the same applier and type-check as the <code>ts-capture</code> CLI. A real project also gets its test runner, several files and its own <code>tsconfig.json</code>.</li>
  </ul>`
      : markup`<ul class="limits"${shown}>
    <li>One value. A list of objects that differ becomes one shape, with the fields only some have optional.</li>
    <li>Nothing is written when part of the value is unknown: an empty list seen alone, or an object nested deeper than Depth levels.</li>
    <li>A type is only as good as the values behind it. See <a href="../docs/explanation/what-it-cannot-infer/">what it cannot infer</a>.</li>
  </ul>`,
  );
  return renderLayout(
    {
      id: "playground",
      title: "Playground",
      description:
        "Run ts-capture in your browser: write untyped TypeScript, call it, and see the types it observed written back.",
      top: markup`<h1>Playground</h1>
  ${intro}`,
      body: markup`<main id="content">
  <noscript><p class="empty">The playground needs JavaScript. The <a href="../examples/">examples</a> do not.</p></noscript>
  <div class="controls">
    <label for="starter">Start from</label>
    <select id="starter">${options}</select>
    ${jsonFields}
    <button type="button" id="run">Run</button>
    <span class="status" id="status" role="status"></span>
  </div>
  ${renderOptions({ ...OPTION_DEFAULTS, ...starters[0]?.options })}
  <div class="panes playground">
    <figure><figcaption><label for="code">${codeCaption}</label></figcaption><textarea id="code" spellcheck="false" autocapitalize="off" autocomplete="off">${starters[0].code}</textarea></figure>
    <figure class="result"><figcaption>${resultCaption}</figcaption><pre><code id="result"></code></pre></figure>
  </div>
  <div class="outcome"><pre id="report"></pre></div>
  ${limits}
</main>`,
      extra: markup`<script type="application/json" id="starters">${embeddedJson(starters)}</script>`,
    },
    build,
  );
}
