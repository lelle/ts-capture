// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderHomePage } from "../home.js";
import { setUpDemo } from "./demo.js";
import { stubMatchMedia } from "./stubs.js";

const shown = (): HTMLImageElement =>
  document.querySelector<HTMLImageElement>(".demo img.shown")!;
const step = (n: number): HTMLAnchorElement =>
  document.querySelectorAll<HTMLAnchorElement>(".demo .steps a")[n - 1]!;
const marked = (): number[] =>
  [...document.querySelectorAll(".demo .steps a")].flatMap((link, i) =>
    link.getAttribute("aria-current") === "step" ? [i + 1] : [],
  );

function render(reducedMotion: boolean): void {
  document.body.innerHTML = renderHomePage({ version: "0.4.0" });
  stubMatchMedia(
    (query) => reducedMotion && query === "(prefers-reduced-motion: reduce)",
  );
  setUpDemo();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("setUpDemo", () => {
  it("turns to the next step every 4 s, and from the last back to the first", () => {
    render(false);
    vi.advanceTimersByTime(4000);
    expect(shown().getAttribute("src")).toBe("demo-2.webp");
    expect(shown().getAttribute("srcset")).toBe("demo-2@2x.webp 2x");
    expect(marked()).toEqual([2]);
    vi.advanceTimersByTime(4 * 4000);
    expect(shown().getAttribute("src")).toBe("demo-1.webp");
  });

  it("shows the step a reader picks, names it, and stops turning", () => {
    render(false);
    step(3).click();
    expect(shown().getAttribute("src")).toBe("demo-3.webp");
    expect(shown().alt).toBe(step(3).textContent!.trim());
    expect(marked()).toEqual([3]);
    vi.advanceTimersByTime(3 * 4000);
    expect(marked()).toEqual([3]);
  });

  it("keeps still for a reader who asked for less motion, and still shows a pick", () => {
    render(true);
    vi.advanceTimersByTime(3 * 4000);
    expect(marked()).toEqual([1]);
    step(5).click();
    expect(shown().getAttribute("src")).toBe("demo-5.webp");
  });
});
