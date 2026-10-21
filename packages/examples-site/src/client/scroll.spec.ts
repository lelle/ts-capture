// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPageHeight, setPageHeight } from "./page-height.js";
import { atPageBottom, onScrollFrame } from "./scroll.js";

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
  afterEach(resetPageHeight);

  it("counts the last two pixels as the bottom, and nothing above them", () => {
    setPageHeight(innerHeight + 2);
    expect(atPageBottom()).toBe(true);
    setPageHeight(innerHeight + 3);
    expect(atPageBottom()).toBe(false);
  });
});
