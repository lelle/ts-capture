import { renderCode } from "./code.js";
import { type BuildInfo, renderLayout } from "./layout.js";
import { join, type Markup, markup } from "./markup.js";

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

function fileReference(example: Example, source: ExampleSource): Markup {
  const place = `${example.file}:${example.line}`;
  if (!source.url) return markup`<span class="file">${place}</span>`;
  const href = `${source.url}/blob/${source.commit}/${example.file}#L${example.line}`;
  return markup`<a class="file" href="${href}">${place}</a>`;
}

/** A link from an example to the card on How it decides that shows its rule. */
export interface RuleLink {
  href: string;
  label: string;
}

/** Everything but the title: what was written, where, and why. */
export function renderExampleBody(
  example: Example,
  source: ExampleSource,
): Markup {
  const verdict = VERDICTS[example.verdict];
  const better =
    example.better &&
    markup`<p class="note better"><span class="note-label">A reviewer would write</span> <code>${example.better}</code></p>`;
  const left =
    example.leftAlone &&
    markup`<dl class="note left-alone">
        <dt>Not written</dt><dd><code>${example.leftAlone.name}</code> · ${example.leftAlone.group.toLowerCase()}</dd>
        ${example.leftAlone.observed && markup`<dt>Observed</dt><dd><code>${example.leftAlone.observed}</code></dd>`}
        ${example.leftAlone.reason && markup`<dt>Why</dt><dd>${example.leftAlone.reason}</dd>`}
      </dl>`;
  return markup`<p class="meta">
          <span class="verdict verdict-${example.verdict}" title="${verdict.summary}">${verdict.label}</span>
          <span class="source">${source.name}</span>
          ${fileReference(example, source)}
        </p>
      <div class="panes">
        <figure><figcaption>Before</figcaption><pre><code>${renderCode(example.before, example.before)}</code></pre></figure>
        <figure><figcaption>After <code>ts-capture apply</code></figcaption><pre><code>${renderCode(example.before, example.after)}</code></pre></figure>
      </div>
      <p class="caption">${example.caption}</p>
      ${better}${left}`;
}

function renderExample(
  example: Example,
  source: ExampleSource,
  rule: RuleLink | undefined,
): Markup {
  const ruleLine =
    rule &&
    markup`\n      <dl class="note rule"><dt>The rule</dt><dd><a href="${rule.href}">${rule.label} →</a></dd></dl>`;
  return markup`<article id="${example.id}" class="example" data-source="${example.source}" data-verdict="${example.verdict}">
      <header>
        <h2><a href="#${example.id}">${example.title}</a></h2>
      </header>
      ${renderExampleBody(example, source)}${ruleLine}
    </article>`;
}

function renderSources(data: ExamplesData): Markup {
  return join(
    Object.entries(data.sources).map(([id, source]) => {
      const count = data.examples.filter(
        (example) => example.source === id,
      ).length;
      const name = source.url
        ? markup`<a href="${source.url}">${source.name}</a>`
        : source.name;
      return markup`<li><strong>${name}</strong> at <code>${source.commit}</code>, ts-capture <code>${source.tsCapture}</code>, ${count} example${count === 1 ? "" : "s"}. ${source.about}</li>`;
    }),
    "\n",
  );
}

function renderFilters(data: ExamplesData): Markup {
  const button = (
    group: string,
    value: string,
    label: string,
    pressed = false,
  ) =>
    markup`<button type="button" data-filter="${group}" data-value="${value}" aria-pressed="${String(pressed)}">${label}</button>`;
  const sources = Object.entries(data.sources).map(([id, source]) =>
    button("source", id, source.name),
  );
  const verdicts = VERDICT_ORDER.filter((verdict) =>
    data.examples.some((example) => example.verdict === verdict),
  ).map((verdict) => button("verdict", verdict, VERDICTS[verdict].label));
  return markup`<nav class="filters" aria-label="Filter examples" hidden>
      <div role="group" aria-label="Project">${button("source", "", "All projects", true)}${sources}</div>
      <div role="group" aria-label="Result">${button("verdict", "", "All results", true)}${verdicts}</div>
    </nav>`;
}

/**
 * The examples apply wrote. What it left alone is shown on How it decides,
 * beside the rule that left it; `rules` links the rest to theirs.
 */
export function renderPage(
  data: ExamplesData,
  build: BuildInfo,
  rules: ReadonlyMap<string, RuleLink> = new Map(),
): string {
  const written = {
    ...data,
    examples: data.examples.filter((example) => example.verdict !== "left"),
  };
  const examples = join(
    written.examples.map((example) =>
      renderExample(
        example,
        data.sources[example.source]!,
        rules.get(example.id),
      ),
    ),
    "\n",
  );
  return renderLayout(
    {
      id: "examples",
      title: "Examples",
      description:
        "Before and after: what ts-capture wrote into real code, including the results a reviewer should change.",
      top: markup`<h1>Examples</h1>
  <p class="lede">ts-capture watches your code run under its tests and writes the types it saw back into the source. These are annotations it wrote into real code: the ones you would have written yourself, and the ones a reviewer should change. What it left alone, and why, is on <a href="../how-it-decides/">How it decides</a>.</p>
  <p class="how">Nothing here was typed by hand. Each example is cut from the diff of an actual run; the highlighted parts are what <code>apply</code> added.</p>
  ${renderFilters(written)}`,
      body: markup`<main id="content">
${examples}
<p class="empty" hidden>No example matches both filters.</p>
<section class="sources">
  <h2>Where these come from</h2>
  <ul>
${renderSources(written)}
  </ul>
  <p>A type is only as good as what the tests passed in. The examples marked “needs review” are not bugs: they describe the test run exactly, which is why nothing flags them. See <a href="../docs/explanation/what-it-cannot-infer/">what it cannot infer</a> and <a href="../docs/how-to/review-and-apply-safely/">review and apply safely</a>.</p>
</section>
</main>`,
    },
    build,
  );
}
