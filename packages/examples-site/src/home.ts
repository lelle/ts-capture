import { escapeHtml } from "./code.js";
import {
  type BuildInfo,
  ICON_LINK,
  renderSiteBar,
  renderSiteFooter,
  REPO,
} from "./frame.js";
import { STYLE } from "./style.js";

const DOCS = "docs";

export interface Integration {
  guide: string;
  name: string;
  packages: string[];
}

export const INTEGRATIONS: Integration[] = [
  {
    name: "Vite or Vitest",
    packages: ["@ts-capture/vite", "@ts-capture/core"],
    guide: `${DOCS}/how-to/use-with-vite-vitest/`,
  },
  {
    name: "Svelte 5",
    packages: ["@ts-capture/svelte", "@ts-capture/vite", "@ts-capture/core"],
    guide: `${DOCS}/how-to/use-with-svelte/`,
  },
  {
    name: "Jest (Babel)",
    packages: ["@ts-capture/babel-plugin", "@ts-capture/core"],
    guide: `${DOCS}/how-to/use-with-jest-babel/`,
  },
  {
    name: "esbuild or tsup",
    packages: ["@ts-capture/esbuild", "@ts-capture/core"],
    guide: `${REPO}/tree/main/packages/esbuild#readme`,
  },
  {
    name: "Plain Node, no bundler",
    packages: ["@ts-capture/core"],
    guide: `${DOCS}/how-to/use-without-a-bundler/`,
  },
];

function renderIntegration(integration: Integration): string {
  const packages = integration.packages
    .map((name) => `<span class="package">${escapeHtml(name)}</span>`)
    .join(" ");
  return `<li>
      <h3>${escapeHtml(integration.name)}</h3>
      <pre><code>npm install --save-dev ${packages}</code></pre>
      <a href="${escapeHtml(integration.guide)}" aria-label="${escapeHtml(integration.name)} guide">Guide</a>
    </li>`;
}

export function renderHomePage(build: BuildInfo): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ICON_LINK}
<title>ts-capture — runtime values as TypeScript types</title>
<meta name="description" content="ts-capture watches your code run and writes the types it saw back into your source.">
<style>${STYLE}</style>
</head>
<body>
<div class="top">
  ${renderSiteBar("home")}
  <h1>ts-capture</h1>
  <p class="lede">Capture runtime values, shape them as TypeScript types. ts-capture watches how your code is called — in tests, in dev, in the browser — and writes the types it saw back into your source.</p>
</div>
<main>
  <figure class="demo">
    <video src="demo.mp4" width="960" height="720" muted loop playsinline controls preload="metadata" aria-describedby="demo-description"></video>
    <figcaption id="demo-description">An order form whose code has no types. The ts-capture plugin is added to the Vite config, two orders are placed in the browser, and <code>ts-capture apply</code> writes four named types and six annotations into the source, taking type coverage from 77% to 100%.</figcaption>
  </figure>
  <p class="how">The recording is made by running every step for real; nothing in it is written by hand. See <a href="examples/">what it wrote into real projects</a>, the results a reviewer should change included, or <a href="playground/">try it in your browser</a>.</p>
  <h2>Install</h2>
  <ul class="install">
    ${INTEGRATIONS.map(renderIntegration).join("\n    ")}
  </ul>
  <p class="how">Then run your tests, and <code>npx ts-capture apply types.json --dry-run</code> to see what it would write. The <a href="${DOCS}/tutorials/getting-started/">getting started tutorial</a> takes a first run from install to <code>apply</code>.</p>
  <p class="how">Already typed? Run the tests with <code>TS_CAPTURE_OBSERVE_ANNOTATED=1</code> and <code>npx ts-capture verify</code> lists the types you wrote that the run contradicts. See <a href="${DOCS}/how-to/check-your-types/">check the types you wrote</a>.</p>
  <p class="note">ts-capture rewrites your source files, runs your getters while observing, and writes what it observed to disk. Commit your work first, and read <a href="${DOCS}/how-to/review-and-apply-safely/">review and apply safely</a> before pointing it at a real codebase. The packages are 0.x: the API may change between minor versions.</p>
</main>
${renderSiteFooter(build, "home")}
<script type="module" src="js/home.js"></script>
</body>
</html>
`;
}
