import { describe, expect, it } from "vitest";

import { renderDocsPage } from "./docs/page.js";
import { renderHomePage } from "./home.js";
import { renderDecidesPage } from "./how-it-decides/page.js";
import { type BuildInfo, renderLayout } from "./layout.js";
import { markup } from "./markup.js";
import { renderNotFoundPage } from "./not-found.js";
import { type ExamplesData, renderPage } from "./page.js";
import { renderPlaygroundPage } from "./playground/page.js";

// The five pages are one site: the same bar at the top, with the page you are
// on marked, the same footer, and one name per page.

const BUILD = { version: "0.4.0", commit: "abc1234" };
const DATA: ExamplesData = { examples: [], sources: {} };

const pages = {
  home: renderHomePage(BUILD),
  examples: renderPage(DATA, BUILD),
  "how-it-decides": renderDecidesPage([], DATA, BUILD),
  playground: renderPlaygroundPage(
    [{ id: "a", title: "A", code: "f();\n" }],
    BUILD,
  ),
  docs: renderDocsPage(
    "how-to/check-your-types.md",
    "# Check the types you wrote\n",
    [],
    BUILD,
  ),
  "not-found": renderNotFoundPage(BUILD),
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

const stylesheets = (page: string): string[] =>
  [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(
    (m) => m[1]!,
  );

describe("the site frame", () => {
  it.each([
    ["home", ["css/site.css"]],
    ["examples", ["../css/site.css"]],
    ["how-it-decides", ["../css/site.css", "../css/how-it-decides.css"]],
    ["playground", ["../css/site.css"]],
    ["docs", ["../../../css/site.css", "../../../css/docs.css"]],
  ] as const)(
    "%s loads the site's stylesheet, and its own where it has one",
    (id, sheets) => {
      expect(stylesheets(pages[id])).toEqual(sheets);
      expect(pages[id]).not.toContain("<style>");
    },
  );

  it.each(Object.entries(pages))(
    "%s has the same bar as the others",
    (_, page) => {
      expect(items(page)).toEqual([
        "ts-capture",
        "In real code",
        "How it decides",
        "Playground",
        "Docs",
      ]);
    },
  );

  it.each(Object.entries(pages))(
    "%s links GitHub by its mark, named for screen readers",
    (_, page) => {
      expect(bar(page)).toMatch(
        /<a href="https:\/\/github\.com\/lelle\/ts-capture" aria-label="GitHub"><svg [^>]*aria-hidden="true"/,
      );
    },
  );

  it.each([
    ["home", "js/theme.js"],
    ["examples", "../js/theme.js"],
    ["docs", "../../../js/theme.js"],
  ] as const)(
    "%s sets the theme before its stylesheets, and hides the switch until a script runs it",
    (id, script) => {
      const page = pages[id];
      const at = page.indexOf(`<script src="${script}"></script>`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(page.indexOf('<link rel="stylesheet"'));
      expect(bar(page)).toContain(
        '<button type="button" class="theme" hidden>',
      );
    },
  );

  it.each([
    ["home", "ts-capture"],
    ["examples", "In real code"],
    ["how-it-decides", "How it decides"],
    ["playground", "Playground"],
    ["docs", "Docs"],
  ] as const)("%s marks itself in the bar", (id, name) => {
    expect(marked(pages[id])).toEqual([name]);
  });

  it.each([
    ["examples", "In real code"],
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

  it("links every page to the site's own docs, from wherever the page sits", () => {
    const docsLinks = (page: string): string[] =>
      [...page.matchAll(/<a href="([^"]*)"[^>]*>Docs<\/a>/g)].map((m) => m[1]!);
    expect(docsLinks(pages.home)).toEqual(["docs/", "docs/"]);
    expect(docsLinks(pages.examples)).toEqual(["../docs/", "../docs/"]);
    expect(docsLinks(pages.docs)).toEqual(["../../../docs/", "../../../docs/"]);
  });

  it.each(Object.entries(pages))(
    "%s carries its icon inline, so no page asks for /favicon.ico",
    (_, page) => {
      expect(page).toMatch(
        /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,[^"]+">/,
      );
    },
  );

  const meta = (page: string): Record<string, string> =>
    Object.fromEntries(
      [
        ...page.matchAll(
          /<meta (?:property|name)="((?:og|twitter):[\w:]+)" content="([^"]*)">/g,
        ),
      ].map((m) => [m[1]!, m[2]!]),
    );

  it.each([
    ["home", "https://lelle.github.io/ts-capture/"],
    ["examples", "https://lelle.github.io/ts-capture/examples/"],
    [
      "docs",
      "https://lelle.github.io/ts-capture/docs/how-to/check-your-types/",
    ],
  ] as const)(
    "%s shows as a card where it is shared, with its own title and address",
    (id, url) => {
      const tags = meta(pages[id]);
      expect(tags["og:url"]).toBe(url);
      expect(tags["og:title"]).toBe(
        /<title>([^<]*)<\/title>/.exec(pages[id])![1],
      );
      expect(tags["og:image"]).toBe(
        "https://lelle.github.io/ts-capture/og.png",
      );
      expect(tags["twitter:card"]).toBe("summary_large_image");
    },
  );

  it("describes the card as the page describes itself, and leaves it out where the page has none", () => {
    expect(meta(pages.home)["og:description"]).toBe(
      /<meta name="description" content="([^"]*)">/.exec(pages.home)![1],
    );
    expect(meta(pages.docs)).not.toHaveProperty("og:description");
  });

  it.each(Object.entries(pages))(
    "%s lets a keyboard skip the bar, to the page's one main part",
    (_, page) => {
      const body = page.slice(page.indexOf("<body>") + "<body>".length);
      expect(body.trimStart()).toMatch(
        /^<a class="skip" href="#content">Skip to content<\/a>/,
      );
      expect(page.match(/<main[^>]* id="content"/g)).toHaveLength(1);
    },
  );

  it("sends a reader who followed a dead link on to pages that exist, from any depth", () => {
    const page = pages["not-found"];
    expect(page).toContain("<title>Page not found · ts-capture</title>");
    expect(marked(page)).toEqual([]);
    const links = [...page.matchAll(/href="([^"#]+)"/g)]
      .map((m) => m[1]!)
      .filter((href) => !href.startsWith("http") && !href.startsWith("data:"));
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).toMatch(/^\/ts-capture\//);
    expect(page).not.toContain('<script type="module"');
  });

  it.each(Object.entries(pages))(
    "%s is counted, once, and says so in the footer",
    (_, page) => {
      const counters =
        page.match(/<script [^>]*data-goatcounter="[^"]+"[^>]*><\/script>/g) ??
        [];
      expect(counters).toEqual([
        '<script async data-goatcounter="https://ts-capture.goatcounter.com/count" src="https://gc.zgo.at/count.js"></script>',
      ]);
      const footer = page.slice(page.indexOf('<footer class="site"'));
      expect(footer).toContain(
        'Visits are counted by <a href="https://www.goatcounter.com/help/privacy">GoatCounter</a>, without cookies.',
      );
    },
  );

  it("leaves the commit out when the build does not know it", () => {
    expect(renderHomePage({ version: "0.4.0" })).not.toContain("/commit/");
  });

  // The site is built from main, which runs ahead of npm until the next release.
  const builtFrom = (build: BuildInfo): string =>
    /<p>(Built from[\s\S]*?)<\/p>/
      .exec(renderHomePage(build))![1]!
      .replaceAll(/<[^>]+>/g, "");

  it("says main is past the version while changes wait for a release", () => {
    expect(
      builtFrom({ version: "0.3.0", commit: "abc1234", unreleased: true }),
    ).toBe("Built from main at abc1234, after ts-capture 0.3.0");
  });

  it("names the version alone when main is that release", () => {
    expect(builtFrom({ version: "0.4.0", commit: "abc1234" })).toBe(
      "Built from ts-capture 0.4.0 · abc1234",
    );
  });

  it("says the same without a commit", () => {
    expect(builtFrom({ version: "0.3.0", unreleased: true })).toBe(
      "Built from main, after ts-capture 0.3.0",
    );
  });
});

describe("renderLayout", () => {
  const page = renderLayout(
    {
      id: "examples",
      title: "Examples",
      description: "Before & after.",
      top: markup`<h1>Examples</h1>`,
      body: markup`<main>cards</main>`,
      extra: markup`<script type="application/json">{}</script>`,
    },
    BUILD,
  );
  const order = (...parts: string[]): number[] =>
    parts.map((part) => page.indexOf(part));

  it("names the page, then the site", () => {
    expect(page).toContain("<title>Examples · ts-capture</title>");
    expect(page).toContain(
      '<meta name="description" content="Before &amp; after.">',
    );
  });

  it("leaves the home page its own title, and a page without a description without one", () => {
    const home = renderLayout(
      { id: "home", title: "ts-capture — types", body: markup`<main></main>` },
      BUILD,
    );
    expect(home).toContain("<title>ts-capture — types</title>");
    expect(home).not.toContain('name="description"');
  });

  it("keeps the bar on every page in a header of its own, so it can stay while the top scrolls away", () => {
    for (const page of Object.values(pages)) {
      expect(page).toMatch(
        /<header class="bar"><nav class="site"[\s\S]*?<\/nav><\/header>\s*<div class="top">/,
      );
    }
  });

  it("puts the bar and the top first, then the page, the footer, and the scripts last", () => {
    const at = order(
      '<nav class="site"',
      "<h1>Examples</h1>",
      "<main>cards</main>",
      '<footer class="site">',
      '<script type="application/json">',
      '<script type="module" src="../js/examples.js">',
    );
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});
