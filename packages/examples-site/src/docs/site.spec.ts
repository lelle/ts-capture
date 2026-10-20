import { globSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readMenu } from "./menu.js";
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

// The pages built beside the docs, which a docs page may link to.
const OTHER_PAGES = ["", "examples/", "how-it-decides/", "playground/"];

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
        const page = pages.get(at);
        if (!page && !OTHER_PAGES.includes(at)) broken.push(href!);
        else if (anchor && page && !page.includes(`id="${anchor}"`))
          broken.push(href!);
      }
      expect(broken).toEqual([]);
    },
  );
});
