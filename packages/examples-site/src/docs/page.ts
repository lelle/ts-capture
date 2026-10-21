import type { Highlight } from "./highlight.js";
import type { MenuGroup } from "./menu.js";

import { type BuildInfo, renderLayout } from "../layout.js";
import { join, type Markup, markup } from "../markup.js";
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
  return renderLayout(
    {
      id: "docs",
      title: name,
      root: root,
      path: here,
      body: markup`<div class="docs">
${renderMenu(file, menu, doc.title, doc.headings)}
<main class="doc" id="content">
${doc.html}
${renderPager(file, menu)}
</main>
</div>`,
    },
    build,
  );
}

/** The pages either side of this one, in menu order from the overview on. */
function renderPager(file: string, menu: MenuGroup[]): Markup {
  const here = sitePathOf(file);
  const order = [
    { file: INDEX, name: "Overview", group: "Docs" },
    ...menu.flatMap((group) =>
      group.pages.map((page) => ({ ...page, group: group.name })),
    ),
  ];
  const at = order.findIndex((page) => page.file === file);
  const link = (side: "prev" | "next", label: string): Markup | undefined => {
    const page = order[side === "prev" ? at - 1 : at + 1];
    if (at === -1 || !page) return undefined;
    return markup`<a class="${side}" href="${relativeHref(here, sitePathOf(page.file))}"><span class="dir">${label}</span><span class="group">${page.group}</span><span class="name">${page.name}</span></a>`;
  };
  return markup`<nav class="pager" aria-label="Previous and next">${link("prev", "← Previous")}${link("next", "Next →")}</nav>`;
}

function renderMenu(
  file: string,
  menu: MenuGroup[],
  title: string,
  headings: Heading[],
): Markup {
  const here = sitePathOf(file);
  const item = (target: string, name: string): Markup => {
    const current = target === file;
    const sections =
      current &&
      headings.length > 0 &&
      markup`<ul class="sections">${headings.map((h) => markup`<li><a href="#${h.id}">${h.menu}</a></li>`)}</ul>`;
    return markup`<li><a href="${relativeHref(here, sitePathOf(target))}"${current && markup` aria-current="page"`}>${name}</a>${sections}</li>`;
  };
  const groups = join(
    menu.map(
      (group) =>
        markup`<p class="docs-group">${group.name}</p><ul>${group.pages.map((page) => item(page.file, page.name))}</ul>`,
    ),
    "\n",
  );
  const reading = file === INDEX ? "Overview" : title;
  return markup`<details class="docs-menu" open><summary>Docs · ${reading}</summary>
<nav aria-label="Docs">
<ul>${item(INDEX, "Overview")}</ul>
${groups}
</nav>
</details>`;
}
