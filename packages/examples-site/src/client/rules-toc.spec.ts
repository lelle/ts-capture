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
});
