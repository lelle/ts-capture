import { describe, expect, it } from "vitest";

import { readMenu } from "./menu.js";

// The menu is the four lists in docs/README.md, so the order a reader is
// offered is written once, where GitHub shows it too.

const README = `# ts-capture documentation

## Start here

- **New?** Read [How it works](explanation/how-it-works.md) first.

## The four kinds of docs

### Tutorials — learning by doing

- [Getting started](tutorials/getting-started.md) — a guided first run, from
  install to a successful \`apply\`.

### How-to guides — task-focused

- [Use with Vite / Vitest](how-to/use-with-vite-vitest.md)
- [Check the types you wrote](how-to/check-your-types.md)

### Reference — facts

- [CLI](reference/cli.md) — every command and flag.
`;

describe("readMenu", () => {
  it("takes the groups and pages from the four lists, in their order", () => {
    expect(readMenu(README)).toEqual([
      {
        name: "Tutorials",
        pages: [
          { name: "Getting started", file: "tutorials/getting-started.md" },
        ],
      },
      {
        name: "How-to guides",
        pages: [
          {
            name: "Use with Vite / Vitest",
            file: "how-to/use-with-vite-vitest.md",
          },
          {
            name: "Check the types you wrote",
            file: "how-to/check-your-types.md",
          },
        ],
      },
      {
        name: "Reference",
        pages: [{ name: "CLI", file: "reference/cli.md" }],
      },
    ]);
  });

  it("leaves the links in the introduction out of the menu", () => {
    const files = readMenu(README).flatMap((group) =>
      group.pages.map((p) => p.file),
    );
    expect(files).not.toContain("explanation/how-it-works.md");
  });
});
