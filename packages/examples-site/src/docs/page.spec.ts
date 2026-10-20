import { describe, expect, it } from "vitest";

import type { MenuGroup } from "./menu.js";

import { renderDocsPage } from "./page.js";

const MENU: MenuGroup[] = [
  {
    name: "How-to guides",
    pages: [
      {
        name: "Use with Vite / Vitest",
        file: "how-to/use-with-vite-vitest.md",
      },
      { name: "Check the types you wrote", file: "how-to/check-your-types.md" },
    ],
  },
  { name: "Reference", pages: [{ name: "CLI", file: "reference/cli.md" }] },
];

const SOURCE = `# Check the types you wrote

Goal: find them.

## What is checked

Text.

## Merge and verify

Text.
`;

const BUILD = { version: "0.4.0" };
const page = renderDocsPage("how-to/check-your-types.md", SOURCE, MENU, BUILD);
const menu = page.slice(
  page.indexOf('<details class="docs-menu"'),
  page.indexOf("</details>"),
);

describe("renderDocsPage", () => {
  it("is named after its heading", () => {
    expect(page).toContain(
      "<title>Check the types you wrote · ts-capture</title>",
    );
    expect(page).toContain(
      '<h1 id="check-the-types-you-wrote">Check the types you wrote</h1>',
    );
  });

  it("calls the index Docs, in the title and the heading alike", () => {
    const index = renderDocsPage(
      "README.md",
      "# ts-capture documentation\n",
      MENU,
      BUILD,
    );
    expect(index).toContain("<title>Docs · ts-capture</title>");
    expect(index).toContain('<h1 id="docs">Docs</h1>');
    expect(index).not.toContain("ts-capture documentation");
  });

  it("lists every page in the menu under its group, relative to this page", () => {
    expect(menu).toContain('<p class="docs-group">How-to guides</p>');
    expect(menu).toContain(
      '<a href="../use-with-vite-vitest/">Use with Vite / Vitest</a>',
    );
    expect(menu).toContain('<a href="../../reference/cli/">CLI</a>');
  });

  it("marks the page being read, with its sections under it", () => {
    expect(menu).toContain(
      '<a href="./" aria-current="page">Check the types you wrote</a>',
    );
    expect(menu).toMatch(
      /aria-current="page">Check the types you wrote<\/a><ul class="sections"><li><a href="#what-is-checked">What is checked<\/a><\/li><li><a href="#merge-and-verify">Merge and verify<\/a><\/li><\/ul>/,
    );
  });

  it("lists sections only under the page being read", () => {
    expect(menu.match(/class="sections"/g)).toHaveLength(1);
  });

  it("names the page in the menu's fold, for a narrow screen", () => {
    expect(menu).toContain(
      "<summary>Docs · Check the types you wrote</summary>",
    );
  });

  it("opens the menu without a script, and folds it with one on a narrow screen", () => {
    expect(menu).toMatch(/^<details class="docs-menu" open>/);
    expect(page).toContain('matchMedia("(max-width: 900px)")');
  });

  it("leads the menu back to the index", () => {
    expect(menu).toContain('<a href="../../">Overview</a>');
  });

  it("lists a section in the menu under its short name", () => {
    const cli = renderDocsPage(
      "reference/cli.md",
      "# CLI reference\n\n## `ts-capture verify <types.json> --project <tsconfig.json>`\n",
      MENU,
      BUILD,
    );
    expect(cli).toContain(
      '<li><a href="#ts-capture-verify-typesjson---project-tsconfigjson"><code>verify</code></a></li>',
    );
  });

  it("adds a copy button to marked blocks once its script runs", () => {
    expect(page).toContain('document.querySelectorAll("pre[data-copy]")');
    expect(page).toContain("navigator.clipboard.writeText");
  });
});
