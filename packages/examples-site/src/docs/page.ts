import type { Highlight } from "./highlight.js";
import type { MenuGroup } from "./menu.js";

import { escapeHtml } from "../code.js";
import {
  type BuildInfo,
  pageTitle,
  renderSiteBar,
  renderSiteFooter,
} from "../frame.js";
import { STYLE } from "../style.js";
import {
  type Heading,
  relativeHref,
  renderMarkdown,
  sitePathOf,
} from "./markdown.js";

const INDEX = "README.md";

/** `file` is the page's path under docs/, `source` its Markdown. */
export function renderDocsPage(
  file: string,
  source: string,
  menu: MenuGroup[],
  build: BuildInfo,
  highlight?: Highlight,
): string {
  // The index is "Docs" on the site, as in the bar; GitHub keeps its own title.
  const doc = renderMarkdown(
    file === INDEX ? source.replace(/^# .*$/m, "# Docs") : source,
    file,
    highlight,
  );
  const here = sitePathOf(file);
  const root = relativeHref(here, "");
  const name = doc.title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle(name))}</title>
<style>${STYLE}${DOCS_STYLE}</style>
</head>
<body>
<div class="top">
  ${renderSiteBar("docs", root)}
</div>
<div class="docs">
${renderMenu(file, menu, doc.title, doc.headings)}
<main class="doc">
${doc.html}
</main>
</div>
${renderSiteFooter(build, "docs", root)}
<script>${MENU_SCRIPT}</script>
</body>
</html>
`;
}

function renderMenu(
  file: string,
  menu: MenuGroup[],
  title: string,
  headings: Heading[],
): string {
  const here = sitePathOf(file);
  const item = (target: string, name: string): string => {
    const current = target === file;
    const sections =
      current && headings.length > 0
        ? `<ul class="sections">${headings.map((h) => `<li><a href="#${h.id}">${h.html}</a></li>`).join("")}</ul>`
        : "";
    return `<li><a href="${relativeHref(here, sitePathOf(target))}"${current ? ' aria-current="page"' : ""}>${escapeHtml(name)}</a>${sections}</li>`;
  };
  const groups = menu
    .map(
      (group) =>
        `<p class="docs-group">${escapeHtml(group.name)}</p><ul>${group.pages.map((page) => item(page.file, page.name)).join("")}</ul>`,
    )
    .join("\n");
  const reading = file === INDEX ? "Overview" : title;
  return `<details class="docs-menu" open><summary>Docs · ${escapeHtml(reading)}</summary>
<nav aria-label="Docs">
<ul>${item(INDEX, "Overview")}</ul>
${groups}
</nav>
</details>`;
}

// Open in the HTML, so the menu is there without a script; folded on a narrow
// screen, where it would push the page down. The section being read is the
// last one whose heading has passed the top, or the last at the bottom.
const MENU_SCRIPT = `
const menu = document.querySelector(".docs-menu");
const narrow = matchMedia("(max-width: 900px)");
if (narrow.matches) menu.open = false;
// Folded before the jump, so it lands where the page is once the menu is closed.
menu.addEventListener("click", (event) => {
  if (narrow.matches && event.target.closest("nav a")) menu.open = false;
});
const links = [...menu.querySelectorAll(".sections a")];
const targets = links.map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))));
let frame = 0;
const update = () => {
  frame = 0;
  let at = -1;
  targets.forEach((target, i) => {
    if (target && target.getBoundingClientRect().top <= 80) at = i;
  });
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) at = targets.length - 1;
  links.forEach((link, i) => link.classList.toggle("on-screen", i === at));
};
addEventListener("scroll", () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
update();
`;

const DOCS_STYLE = `
.docs { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 0 44px; max-width: 1180px; margin: 0 auto; padding: 0 20px; }
.docs-menu { position: sticky; top: 0; align-self: start; max-height: 100vh; overflow-y: auto; padding: 4px 0 24px; font-size: 14px; }
.docs-menu summary { display: none; }
.docs-menu ul { list-style: none; margin: 0; padding: 0; }
.docs-group { margin: 18px 0 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.docs-menu a { display: block; padding: 2px 8px; border-left: 2px solid transparent; color: var(--muted); text-decoration: none; }
.docs-menu a:hover { color: var(--text); }
.docs-menu a[aria-current="page"] { color: var(--text); font-weight: 600; border-left-color: var(--accent); }
.docs-menu .sections a { padding-left: 20px; font-size: 13px; font-weight: 400; }
.docs-menu .sections a.on-screen { color: var(--text); border-left-color: var(--accent); background: var(--code-bg); }
main.doc { max-width: 80ch; margin: 0; padding: 0 0 20px; min-width: 0; }
.doc h2, .doc h3 { scroll-margin-top: 16px; }
.doc h3 { font-size: 17px; margin: 26px 0 10px; }
.doc p, .doc ul, .doc ol { margin: 0 0 14px; }
.doc li { margin-bottom: 4px; }
.doc pre, .doc figure { margin: 0 0 16px; }
.doc .t-inserted { color: var(--good); }
.doc .t-deleted { color: var(--weak); }
.doc :not(pre) > code { background: var(--code-bg); border-radius: 4px; padding: 1px 5px; font-size: 0.88em; overflow-wrap: anywhere; }
.doc table { display: block; overflow-x: auto; border-collapse: collapse; margin: 0 0 18px; font-size: 14.5px; }
.doc th, .doc td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
.doc td:first-child code { white-space: nowrap; }
.doc blockquote { margin: 0 0 16px; padding: 2px 14px; border-left: 3px solid var(--line); color: var(--muted); }
@media (max-width: 900px) {
  .docs { display: block; }
  .docs-menu { position: static; max-height: none; padding: 0 0 8px; margin: 0 0 20px; border-bottom: 1px solid var(--line); }
  .docs-menu summary { display: list-item; padding: 8px 0; font-weight: 600; cursor: pointer; }
}
`;
