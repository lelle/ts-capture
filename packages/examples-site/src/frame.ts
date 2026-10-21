import { type Markup, markup, trusted } from "./markup.js";

export const REPO = "https://github.com/lelle/ts-capture";
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
export const ICON_LINK = markup`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(ICON_SVG)}">`;

export function pageTitle(name: string): string {
  return `${name} · ts-capture`;
}

export function renderSiteBar(current: PageId, root = rootOf(current)): Markup {
  const link = (id: PageId, href: string, name: string): Markup =>
    markup`<a href="${href}"${id === current && trusted(' aria-current="page"')}>${name}</a>`;
  return markup`<nav class="site" aria-label="Site">${link("home", root || "./", "ts-capture")}<span class="pages">${PAGES.map(
    ({ id, name }) => link(id, `${root}${id}/`, name),
  )}</span><span class="out"><a href="${REPO}">GitHub ↗</a></span></nav>`;
}

export function renderSiteFooter(
  build: BuildInfo,
  current: PageId,
  root = rootOf(current),
): Markup {
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
