import { describe, expect, it } from "vitest";

import { renderHomePage } from "./home.js";
import { renderDecidesPage } from "./how-it-decides/page.js";
import { type ExamplesData, renderPage } from "./page.js";
import { renderPlaygroundPage } from "./playground/page.js";

// The four pages are one site: the same bar at the top, with the page you are
// on marked, the same footer, and one name per page.

const BUILD = { version: "0.4.0", commit: "abc1234" };
const DATA: ExamplesData = { examples: [], sources: {} };

const pages = {
  home: renderHomePage(BUILD),
  examples: renderPage(DATA, BUILD),
  "how-it-decides": renderDecidesPage([], new Map(), BUILD),
  playground: renderPlaygroundPage(
    [{ id: "a", title: "A", code: "f();\n" }],
    BUILD,
  ),
};

const bar = (page: string): string =>
  page.slice(
    page.indexOf('<nav class="site"'),
    page.indexOf("</nav>", page.indexOf('<nav class="site"')),
  );
const items = (page: string): string[] =>
  [...bar(page).matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]!);
const marked = (page: string): string[] =>
  [...bar(page).matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]+)<\/a>/g)].map(
    (m) => m[1]!,
  );

describe("the site frame", () => {
  it.each(Object.entries(pages))(
    "%s has the same bar as the others",
    (_, page) => {
      expect(items(page)).toEqual([
        "ts-capture",
        "Examples",
        "How it decides",
        "Playground",
        "Docs ↗",
        "GitHub ↗",
      ]);
    },
  );

  it.each([
    ["home", "ts-capture"],
    ["examples", "Examples"],
    ["how-it-decides", "How it decides"],
    ["playground", "Playground"],
  ] as const)("%s marks itself in the bar", (id, name) => {
    expect(marked(pages[id])).toEqual([name]);
  });

  it.each([
    ["examples", "Examples"],
    ["how-it-decides", "How it decides"],
    ["playground", "Playground"],
  ] as const)(
    "%s has one name: in the bar, the heading and the title",
    (id, name) => {
      expect(pages[id]).toContain(`<title>${name} · ts-capture</title>`);
      expect(pages[id]).toContain(`<h1>${name}</h1>`);
    },
  );

  it.each(Object.entries(pages))(
    "%s ends in the same footer, with the version and commit it was built from",
    (_, page) => {
      const footer = page.slice(page.indexOf('<footer class="site"'));
      expect(footer).toContain("ts-capture 0.4.0");
      expect(footer).toContain(
        '<a href="https://github.com/lelle/ts-capture/commit/abc1234">abc1234</a>',
      );
      expect(footer).toContain("MIT licence");
    },
  );

  it("leaves the commit out when the build does not know it", () => {
    expect(renderHomePage({ version: "0.4.0" })).not.toContain("/commit/");
  });
});
