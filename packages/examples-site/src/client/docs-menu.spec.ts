// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderDocsPage } from "../docs/page.js";
import { setUpCopyButtons, setUpDocsMenu } from "./docs-menu.js";
import { resetPageHeight, setPageHeight, stubMatchMedia } from "./stubs.js";

const SOURCE = `# Check the types you wrote

Goal: find them.

\`\`\`sh
npx ts-capture verify types.json
\`\`\`

## What is checked

Text.

## Merge and verify

Text.

\`\`\`text
3 observed positions
\`\`\`
`;

const MENU = [
  {
    name: "How-to guides",
    pages: [
      { name: "Check the types you wrote", file: "how-to/check-your-types.md" },
    ],
  },
];

function render(narrow: boolean): HTMLDetailsElement {
  document.body.innerHTML = renderDocsPage(
    "how-to/check-your-types.md",
    SOURCE,
    MENU,
    { version: "0.4.0" },
  );
  stubMatchMedia(() => narrow);
  return document.querySelector<HTMLDetailsElement>(".docs-menu")!;
}

const sectionLinks = (): HTMLAnchorElement[] => [
  ...document.querySelectorAll<HTMLAnchorElement>(".docs-menu .sections a"),
];

const marked = (): string[] =>
  sectionLinks()
    .filter((link) => link.classList.contains("on-screen"))
    .map((link) => link.hash);

describe("setUpDocsMenu", () => {
  afterEach(resetPageHeight);

  it("leaves the menu open on a wide screen", () => {
    const menu = render(false);
    setUpDocsMenu();
    expect(menu.open).toBe(true);
  });

  it("folds the menu on a narrow screen, and again after a link in it is followed", () => {
    const menu = render(true);
    setUpDocsMenu();
    expect(menu.open).toBe(false);
    menu.open = true;
    sectionLinks()[0]!.click();
    expect(menu.open).toBe(false);
  });

  it("marks the last section whose heading has passed under the top of the screen", () => {
    render(false);
    const tops: Record<string, number> = {
      "merge-and-verify": 400,
      "what-is-checked": 20,
    };
    for (const [id, top] of Object.entries(tops)) {
      vi.spyOn(
        document.getElementById(id)!,
        "getBoundingClientRect",
      ).mockReturnValue({ top } as DOMRect);
    }
    setPageHeight(5000);
    setUpDocsMenu();
    expect(marked()).toEqual(["#what-is-checked"]);
  });

  it("marks the last section once the page is scrolled to the bottom", () => {
    render(false);
    for (const id of ["what-is-checked", "merge-and-verify"]) {
      vi.spyOn(
        document.getElementById(id)!,
        "getBoundingClientRect",
      ).mockReturnValue({ top: 400 } as DOMRect);
    }
    setPageHeight(window.innerHeight);
    setUpDocsMenu();
    expect(marked()).toEqual(["#merge-and-verify"]);
  });
});

describe("setUpCopyButtons", () => {
  beforeEach(() => {
    render(false);
    setUpCopyButtons();
  });

  it("gives every block a copy button, except output", () => {
    expect(document.querySelectorAll("pre button.copy")).toHaveLength(1);
    expect(
      document.querySelector("pre button.copy")!.closest("pre")!.textContent,
    ).toContain("npx ts-capture verify");
  });

  it("copies the block's code, not the button's label, and says it did", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const button =
      document.querySelector<HTMLButtonElement>("pre button.copy")!;
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith("npx ts-capture verify types.json");
  });
});
