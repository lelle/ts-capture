// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { atPageBottom, onScrollFrame } from "./scroll.js";

const pageHeight = (height: number): void => {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: height,
  });
};

describe("onScrollFrame", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once for every scroll in a frame, and again in the next frame", () => {
    const update = vi.fn();
    onScrollFrame(update);
    dispatchEvent(new Event("scroll"));
    dispatchEvent(new Event("scroll"));
    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(update).toHaveBeenCalledTimes(1);
    dispatchEvent(new Event("scroll"));
    vi.advanceTimersToNextFrame();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("atPageBottom", () => {
  it("counts the last two pixels as the bottom, and nothing above them", () => {
    pageHeight(innerHeight + 2);
    expect(atPageBottom()).toBe(true);
    pageHeight(innerHeight + 3);
    expect(atPageBottom()).toBe(false);
  });
});
