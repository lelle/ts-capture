// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderHomePage } from "../home.js";
import { applySavedTheme, setUpThemeSwitch } from "./theme.js";

const root = document.documentElement;

const systemIsDark = (dark: boolean): void => {
  window.matchMedia = ((query: string) => ({
    matches: dark,
    media: query,
  })) as typeof window.matchMedia;
};

const storageFails = (method: "getItem" | "setItem"): void => {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new Error("blocked");
  });
};

beforeEach(() => {
  localStorage.clear();
  delete root.dataset.theme;
  systemIsDark(false);
});

afterEach(() => vi.restoreAllMocks());

describe("applySavedTheme", () => {
  it("puts the page in the theme the reader chose last", () => {
    localStorage.setItem("theme", "dark");
    applySavedTheme();
    expect(root.dataset.theme).toBe("dark");
  });

  it("leaves the page to the system when nothing, or no theme, was saved", () => {
    applySavedTheme();
    expect(root.dataset.theme).toBeUndefined();
    localStorage.setItem("theme", "blue");
    applySavedTheme();
    expect(root.dataset.theme).toBeUndefined();
  });

  it("leaves the page to the system when storage cannot be read", () => {
    storageFails("getItem");
    expect(() => applySavedTheme()).not.toThrow();
    expect(root.dataset.theme).toBeUndefined();
  });
});

describe("setUpThemeSwitch", () => {
  const button = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>("button.theme")!;
  const icon = (name: string): SVGElement =>
    button().querySelector<SVGElement>(`.${name}`)!;

  beforeEach(() => {
    document.body.innerHTML = renderHomePage({ version: "0.4.0" });
  });

  it("shows the switch, offering the theme the system has not chosen", () => {
    systemIsDark(true);
    setUpThemeSwitch();
    expect(button().hidden).toBe(false);
    expect(button().getAttribute("aria-label")).toBe("Switch to light theme");
    expect(icon("to-light").hasAttribute("hidden")).toBe(false);
    expect(icon("to-dark").hasAttribute("hidden")).toBe(true);
  });

  it("flips the theme on a click, and remembers it", () => {
    setUpThemeSwitch();
    button().click();
    expect(root.dataset.theme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(button().getAttribute("aria-label")).toBe("Switch to light theme");
    button().click();
    expect(root.dataset.theme).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("starts from the saved theme, not the system's", () => {
    root.dataset.theme = "dark";
    setUpThemeSwitch();
    expect(button().getAttribute("aria-label")).toBe("Switch to light theme");
  });

  it("still flips when the choice cannot be saved", () => {
    storageFails("setItem");
    setUpThemeSwitch();
    button().click();
    expect(root.dataset.theme).toBe("dark");
  });
});
