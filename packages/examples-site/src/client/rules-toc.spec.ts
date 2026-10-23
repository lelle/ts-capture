// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CorpusRule } from "../how-it-decides/corpus.js";

import { renderDecidesPage } from "../how-it-decides/page.js";
import { setUpRulesToc } from "./rules-toc.js";
import { resetPageHeight, setPageHeight } from "./stubs.js";

const rule = (id: CorpusRule["id"], title: string) => ({
  rule: { id, title, about: "", examples: [] },
  examples: [],
});

beforeEach(() => {
  document.body.innerHTML = renderDecidesPage(
    [
      rule("syntax.ignored", "Asked to stay out"),
      rule("gate.redundant", "TypeScript already knows"),
    ],
    { sources: {}, examples: [] },
    { version: "0.4.0" },
  );
});

afterEach(resetPageHeight);

const toggle = (): HTMLButtonElement => document.querySelector(".toc-toggle")!;
const links = (): HTMLAnchorElement[] => [
  ...document.querySelectorAll<HTMLAnchorElement>(".toc-list a"),
];
const marked = (): string[] =>
  links()
    .filter((link) => link.classList.contains("on-screen"))
    .map((link) => link.hash);
const placeAt = (tops: Record<string, number>): void => {
  for (const [id, top] of Object.entries(tops)) {
    vi.spyOn(
      document.getElementById(id)!,
      "getBoundingClientRect",
    ).mockReturnValue({
      top,
    } as DOMRect);
  }
};

const list = (): HTMLElement => document.querySelector(".toc-list")!;
/** The menu's box, and the tops of the links in it, each 20 tall. */
const showMenu = (
  box: { top: number; bottom: number },
  tops: Record<string, number>,
): void => {
  vi.spyOn(list(), "getBoundingClientRect").mockReturnValue(box as DOMRect);
  for (const [id, top] of Object.entries(tops)) {
    vi.spyOn(
      document.querySelector(`.toc-list a[href="#${id}"]`)!,
      "getBoundingClientRect",
    ).mockReturnValue({ top, bottom: top + 20 } as DOMRect);
  }
};

describe("setUpRulesToc", () => {
  it("opens and folds the menu with its button, and folds it when a rule is picked", () => {
    setUpRulesToc();
    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    links()[0]!.click();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("marks the last rule whose heading has passed the top, and names it on the bar", () => {
    placeAt({ "syntax.ignored": 20, "gate.redundant": 400 });
    setPageHeight(5000);
    setUpRulesToc();
    expect(marked()).toEqual(["#syntax.ignored"]);
    expect(document.querySelector(".toc-current")!.textContent).toBe(
      "Asked to stay out",
    );
  });

  it("marks the last rule once the page is scrolled to the bottom", () => {
    placeAt({ "syntax.ignored": 400, "gate.redundant": 400 });
    setPageHeight(window.innerHeight);
    setUpRulesToc();
    expect(marked()).toEqual(["#gate.redundant"]);
  });

  it("scrolls the menu just enough to show the rule it marks", () => {
    placeAt({ "syntax.ignored": 400, "gate.redundant": 20 });
    setPageHeight(5000);
    showMenu({ top: 0, bottom: 300 }, { "gate.redundant": 500 });
    setUpRulesToc();
    expect(list().scrollTop).toBe(220);
  });

  it("leaves the menu where it is while the rule it marks shows", () => {
    placeAt({ "syntax.ignored": 400, "gate.redundant": 20 });
    setPageHeight(5000);
    showMenu({ top: 0, bottom: 300 }, { "gate.redundant": 100 });
    setUpRulesToc();
    expect(list().scrollTop).toBe(0);
  });

  it("shows the marked rule when the folded menu opens", () => {
    placeAt({ "syntax.ignored": 20, "gate.redundant": 400 });
    setPageHeight(5000);
    showMenu({ top: 0, bottom: 300 }, { "syntax.ignored": 0 });
    setUpRulesToc();
    list().scrollTop = 100;
    showMenu({ top: 40, bottom: 300 }, { "syntax.ignored": 0 });
    toggle().click();
    expect(list().scrollTop).toBe(60);
  });
});
