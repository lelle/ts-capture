// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { type ExamplesData, renderPage } from "../page.js";
import { setUpFilters } from "./filters.js";

const example = (id: string, source: string, verdict: "good" | "weak") => ({
  id,
  title: id,
  verdict,
  caption: "",
  ...(verdict === "weak" ? { better: "string" } : {}),
  source,
  file: "a.ts",
  line: 1,
  before: "f(a)",
  after: "f(a: string)",
});

const DATA: ExamplesData = {
  sources: {
    app: { name: "app", about: "", url: null, commit: "a", tsCapture: "b" },
    lib: { name: "lib", about: "", url: null, commit: "c", tsCapture: "d" },
  },
  examples: [
    example("app-good", "app", "good"),
    example("app-weak", "app", "weak"),
    example("lib-good", "lib", "good"),
  ],
};

const click = (filter: string, value: string): void =>
  document
    .querySelector<HTMLButtonElement>(
      `button[data-filter="${filter}"][data-value="${value}"]`,
    )!
    .click();

const shown = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".example")]
    .filter((card) => !card.hidden)
    .map((card) => card.id);

beforeEach(() => {
  document.body.innerHTML = renderPage(DATA, { version: "0.4.0" });
  setUpFilters();
});

describe("setUpFilters", () => {
  it("shows the filters, which are hidden until the script can run them", () => {
    expect(document.querySelector<HTMLElement>(".filters")!.hidden).toBe(false);
  });

  it("shows only the examples from the chosen source, and marks the choice", () => {
    click("source", "lib");
    expect(shown()).toEqual(["lib-good"]);
    const pressed = [
      ...document.querySelectorAll('button[data-filter="source"]'),
    ].map((button) => button.getAttribute("aria-pressed"));
    expect(pressed.filter((state) => state === "true")).toHaveLength(1);
  });

  it("keeps both filters, and says so when nothing matches them", () => {
    click("verdict", "weak");
    expect(shown()).toEqual(["app-weak"]);
    click("source", "lib");
    expect(shown()).toEqual([]);
    expect(document.querySelector<HTMLElement>(".empty")!.hidden).toBe(false);
  });

  it("shows everything again on All", () => {
    click("source", "lib");
    click("source", "");
    expect(shown()).toEqual(["app-good", "app-weak", "lib-good"]);
  });
});
