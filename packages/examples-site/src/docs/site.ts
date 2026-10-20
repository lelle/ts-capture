import type { BuildInfo } from "../frame.js";
import type { Highlight } from "./highlight.js";

import { sitePathOf } from "./markdown.js";
import { readMenu } from "./menu.js";
import { renderDocsPage } from "./page.js";

/** Every docs page, by its path on the site; `read` takes a path under docs/. */
export function renderDocsSite(
  read: (file: string) => string,
  build: BuildInfo,
  highlight?: Highlight,
): Map<string, string> {
  const menu = readMenu(read("README.md"));
  const files = [
    "README.md",
    ...menu.flatMap((group) => group.pages.map((page) => page.file)),
  ];
  return new Map(
    files.map((file) => [
      sitePathOf(file),
      renderDocsPage(file, read(file), menu, build, highlight),
    ]),
  );
}
