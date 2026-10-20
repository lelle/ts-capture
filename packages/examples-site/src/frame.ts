import { escapeHtml } from "./code.js";

export const REPO = "https://github.com/lelle/ts-capture";
const DOCS = `${REPO}/tree/main/docs`;
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

export type PageId = "home" | "examples" | "how-it-decides" | "playground";

// In the order a reader learns it: what it writes, why, then try it.
const PAGES: { id: Exclude<PageId, "home">; name: string }[] = [
  { id: "examples", name: "Examples" },
  { id: "how-it-decides", name: "How it decides" },
  { id: "playground", name: "Playground" },
];

export function pageTitle(name: string): string {
  return `${name} · ts-capture`;
}

export function renderSiteBar(current: PageId): string {
  const base = current === "home" ? "" : "../";
  const link = (id: PageId, href: string, name: string): string =>
    `<a href="${href}"${id === current ? ' aria-current="page"' : ""}>${name}</a>`;
  return `<nav class="site" aria-label="Site">${link("home", base || "./", "ts-capture")}<span class="pages">${PAGES.map(
    ({ id, name }) => link(id, `${base}${id}/`, name),
  ).join(
    "",
  )}</span><span class="out"><a href="${DOCS}">Docs ↗</a><a href="${REPO}">GitHub ↗</a></span></nav>`;
}

export function renderSiteFooter(build: BuildInfo): string {
  const commit =
    build.commit &&
    `<a href="${REPO}/commit/${escapeHtml(build.commit)}">${escapeHtml(build.commit)}</a>`;
  const version = `ts-capture ${escapeHtml(build.version)}`;
  const builtFrom = build.unreleased
    ? `Built from main${commit ? ` at ${commit}` : ""}, after ${version}`
    : `Built from ${version}${commit ? ` · ${commit}` : ""}`;
  return `<footer class="site">
  <p><a href="${REPO}">GitHub</a> · <a href="${NPM}">npm</a> · <a href="${DOCS}">Docs</a> · MIT licence</p>
  <p>${builtFrom}</p>
</footer>`;
}
