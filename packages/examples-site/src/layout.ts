import { type Markup, markup, trusted } from "./markup.js";

export const REPO = "https://github.com/lelle/ts-capture";
const SITE = "https://lelle.github.io/ts-capture/";
const NPM = "https://www.npmjs.com/package/@ts-capture/core";

/**
 * What the site was built from; the commit is left out when git is not there.
 * `unreleased` is set while changesets wait: main is then past `version`.
 */
export interface BuildInfo {
  version: string;
  commit?: string;
  unreleased?: boolean;
}

export type PageId =
  "home" | "examples" | "how-it-decides" | "playground" | "docs";

// In the order a reader learns it: what it writes, why, then try it.
const PAGES: { id: Exclude<PageId, "home">; name: string }[] = [
  { id: "examples", name: "Examples" },
  { id: "how-it-decides", name: "How it decides" },
  { id: "playground", name: "Playground" },
  { id: "docs", name: "Docs" },
];

/** From a page to the site's root; docs pages sit deeper and pass their own. */
const rootOf = (current: PageId): string => (current === "home" ? "" : "../");

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f5fbf"/><text x="16" y="22" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="16" font-weight="700" fill="#fff">ts</text></svg>';

/** Inline, so no page sends the browser after a /favicon.ico the site lacks. */
const ICON_LINK = markup`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(ICON_SVG)}">`;

// Each page's own rules, beside the ones every page shares.
const OWN_STYLESHEET = new Set<PageId>(["docs", "how-it-decides"]);

function renderStylesheets(current: PageId, root: string): Markup {
  return markup`<link rel="stylesheet" href="${root}css/site.css">${
    OWN_STYLESHEET.has(current) &&
    markup`
<link rel="stylesheet" href="${root}css/${current}.css">`
  }`;
}

// GitHub's mark and the sun and moon, from Primer Octicons (MIT).
const GITHUB_MARK = trusted(
  '<svg class="mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/></svg>',
);
const THEME_ICONS = trusted(
  '<svg class="to-light" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"/></svg><svg class="to-dark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"/></svg>',
);

// What a link to the page shows where it is shared. The card's addresses must
// be absolute.
function renderShareCard(
  title: string,
  description: string | undefined,
  path: string,
): Markup {
  return markup`<meta property="og:type" content="website">
<meta property="og:site_name" content="ts-capture">
<meta property="og:title" content="${title}">
${
  description &&
  markup`<meta property="og:description" content="${description}">
`
}<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">`;
}

function renderSiteBar(current: PageId, root: string): Markup {
  const link = (id: PageId, href: string, name: string): Markup =>
    markup`<a href="${href}"${id === current && markup` aria-current="page"`}>${name}</a>`;
  return markup`<nav class="site" aria-label="Site">${link("home", root || "./", "ts-capture")}<span class="pages">${PAGES.map(
    ({ id, name }) => link(id, `${root}${id}/`, name),
  )}</span><span class="out"><button type="button" class="theme" hidden>${THEME_ICONS}</button><a href="${REPO}" aria-label="GitHub">${GITHUB_MARK}</a></span></nav>`;
}

function renderSiteFooter(build: BuildInfo, root: string): Markup {
  const commit =
    build.commit &&
    markup`<a href="${REPO}/commit/${build.commit}">${build.commit}</a>`;
  const version = `ts-capture ${build.version}`;
  const builtFrom = build.unreleased
    ? markup`Built from main${commit && markup` at ${commit}`}, after ${version}`
    : markup`Built from ${version}${commit && markup` · ${commit}`}`;
  return markup`<footer class="site">
  <p><a href="${REPO}">GitHub</a> · <a href="${NPM}">npm</a> · <a href="${root}docs/">Docs</a> · MIT licence</p>
  <p>${builtFrom}</p>
</footer>`;
}

/** What a page puts inside the layout every page shares. */
export interface Page {
  id: PageId;
  /** The page's name; the home page's is its whole title. */
  title: string;
  description?: string;
  /** From the page to the site's root, for pages deeper than one level. */
  root?: string;
  /** Where the page is under the site's root, for pages deeper than one level. */
  path?: string;
  /** Under the bar, before the page: its heading and introduction. */
  top?: Markup;
  body: Markup;
  /** Before the page's script, after the footer. */
  extra?: Markup;
}

// The playground's script is built beside it, with the worker it starts.
const SCRIPT: Record<PageId, string> = {
  home: "js/home.js",
  examples: "js/examples.js",
  "how-it-decides": "js/how-it-decides.js",
  playground: "playground/main.js",
  docs: "js/docs.js",
};

export function renderLayout(page: Page, build: BuildInfo): string {
  const { id, root = rootOf(id), path = id === "home" ? "" : `${id}/` } = page;
  const title = id === "home" ? page.title : `${page.title} · ts-capture`;
  return markup`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ICON_LINK}
<title>${title}</title>
${
  page.description &&
  markup`<meta name="description" content="${page.description}">
`
}${renderShareCard(title, page.description, path)}
<script src="${root}js/theme.js"></script>
${renderStylesheets(id, root)}
</head>
<body>
<div class="top">
  ${renderSiteBar(id, root)}${
    page.top &&
    markup`
  ${page.top}`
  }
</div>
${page.body}
${renderSiteFooter(build, root)}
${
  page.extra &&
  markup`${page.extra}
`
}<script type="module" src="${root}${SCRIPT[id]}"></script>
</body>
</html>
`.toString();
}
