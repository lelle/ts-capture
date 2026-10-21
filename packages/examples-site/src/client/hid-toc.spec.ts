// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Cell } from "../how-it-decides/cells.js";

import { renderDecidesPage } from "../how-it-decides/page.js";
import { setUpToc } from "./hid-toc.js";

const cell = (kind: Cell["kind"], outcome: Cell["outcome"]): Cell => ({
  kind,
  outcome,
  name: "x",
  title: `${kind} ${outcome}`,
  why: "",
  decidedBy: { file: "a.ts", symbol: "a" },
  unreachable: "Not reached here.",
});

const CARDS = [
  cell("parameter", "written"),
  cell("parameter", "type-error"),
  cell("variable", "written"),
].map((c) => ({ cell: c }));

const scrolledTo: string[] = [];

beforeEach(() => {
  document.body.innerHTML = renderDecidesPage(
    CARDS,
    { sources: {}, examples: [] },
    { version: "0.4.0" },
  );
  window.IntersectionObserver = class {
    observe(): void {}
  } as unknown as typeof IntersectionObserver;
  scrolledTo.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this.id);
  };
  vi.useFakeTimers();
  setUpToc();
});

afterEach(() => vi.useRealTimers());

const kind = (name: string): HTMLAnchorElement =>
  document.querySelector<HTMLAnchorElement>(`#kinds a[data-kind="${name}"]`)!;
const outcome = (name: string): HTMLAnchorElement =>
  document.querySelector<HTMLAnchorElement>(
    `#outcomes a[data-outcome="${name}"]`,
  )!;

describe("setUpToc", () => {
  it("opens and folds the menu with its button", () => {
    const toggle = document.querySelector<HTMLButtonElement>(".toc-toggle")!;
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("goes to a kind's first card, and offers only the outcomes that kind has", () => {
    kind("variable").click();
    expect(scrolledTo).toEqual(["variable-written"]);
    expect(location.hash).toBe("#variable-written");
    expect(kind("variable").hasAttribute("aria-current")).toBe(true);
    expect(kind("parameter").hasAttribute("aria-current")).toBe(false);
    expect(document.getElementById("outcome-heading")!.textContent).toContain(
      kind("variable").textContent!,
    );
    expect(outcome("written").getAttribute("href")).toBe("#variable-written");
    expect(outcome("type-error").getAttribute("aria-disabled")).toBe("true");
  });

  it("names the card it went to in the folded menu's bar", () => {
    kind("variable").click();
    expect(document.querySelector(".toc-current")!.textContent).toBe(
      `${kind("variable").textContent} · written`,
    );
  });

  it("goes to the outcome of the selected kind, and nowhere for one it lacks", () => {
    outcome("type-error").click();
    expect(scrolledTo).toEqual(["parameter-type-error"]);
    kind("variable").click();
    scrolledTo.length = 0;
    outcome("type-error").click();
    expect(scrolledTo).toEqual([]);
  });
});
