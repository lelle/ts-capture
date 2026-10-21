import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderHomePage } from "../home.js";
import { renderPage } from "../page.js";
import { renderPlaygroundPage } from "../playground/page.js";
import { readMenu } from "./menu.js";
import { findRepeats } from "./repeats.js";
import { renderDocsSite } from "./site.js";

// Against the real docs/: a page left out of docs/README.md would be built
// with no way to reach it, and a link GitHub follows has to land on the site.

const docsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs",
);
const read = (file: string): string =>
  readFileSync(resolve(docsDir, file), "utf-8");
const pages = renderDocsSite(read, { version: "0.4.0" });

// The stylesheets the build copies to css/, which every page links to.
const stylesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../styles");

// The pages built beside the docs, which a docs page may link to.
const OTHER_PAGES = ["", "examples/", "how-it-decides/", "playground/"];

const BUILD = { version: "0.4.0" };
const others = {
  "": renderHomePage(BUILD),
  "examples/": renderPage({ examples: [], sources: {} }, BUILD),
  "playground/": renderPlaygroundPage(
    [{ id: "a", title: "A", code: "f();\n" }],
    BUILD,
  ),
};

describe("the docs on the site", () => {
  it("lists every page under docs/ in the menu", () => {
    const listed = readMenu(read("README.md")).flatMap((group) =>
      group.pages.map((page) => page.file),
    );
    const written = globSync("**/*.md", { cwd: docsDir }).filter(
      (file) => file !== "README.md" && !file.startsWith("examples/"),
    );
    expect(listed.toSorted()).toEqual(written.toSorted());
  });

  it("explains each fact in one file, and links to it from the others", () => {
    const repoDir = resolve(docsDir, "..");
    const files = globSync(
      ["docs/**/*.md", "README.md", "packages/*/README.md"],
      { cwd: repoDir, exclude: ["docs/examples/**"] },
    );
    const texts = new Map(
      files.map((file) => [
        file,
        readFileSync(resolve(repoDir, file), "utf-8"),
      ]),
    );
    expect(findRepeats(texts)).toEqual([]);
  });

  it("builds the index and every listed page", () => {
    expect(pages.has("docs/")).toBe(true);
    expect(pages.has("docs/how-to/check-your-types/")).toBe(true);
  });

  it.each([...pages])(
    "%s links only to pages and anchors that exist",
    (path, html) => {
      const broken: string[] = [];
      for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
        if (/^[a-z]+:/i.test(href!)) continue;
        const [target = "", anchor] = href!.split("#");
        const resolved = target
          ? `${posix.normalize(posix.join(path, target))}/`.replace(/\/+$/, "/")
          : path;
        const at = resolved === "./" ? "" : resolved;
        const sheet = /^css\/([\w-]+\.css)\/$/.exec(at)?.[1];
        if (sheet) {
          if (!existsSync(resolve(stylesDir, sheet))) broken.push(href!);
          continue;
        }
        const page = pages.get(at);
        if (!page && !OTHER_PAGES.includes(at)) broken.push(href!);
        else if (anchor && page && !page.includes(`id="${anchor}"`))
          broken.push(href!);
      }
      expect(broken).toEqual([]);
    },
  );

  it.each(Object.entries(others))(
    "the page at '%s' links to docs on the site, and to pages that exist",
    (path, html) => {
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
      expect(hrefs.filter((href) => /\/docs\/.*\.md/.test(href))).toEqual([]);
      const missing = hrefs
        .filter((href) => !/^[a-z]+:/i.test(href) && href.includes("docs/"))
        .filter((href) => !pages.has(posix.join(path, href.split("#")[0]!)));
      expect(missing).toEqual([]);
    },
  );
});
