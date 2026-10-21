// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { renderHomePage } from "../home.js";
import { playDemo } from "./demo.js";

function render(reducedMotion: boolean): ReturnType<typeof vi.fn> {
  document.body.innerHTML = renderHomePage({ version: "0.4.0" });
  window.matchMedia = ((query: string) => ({
    matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
    media: query,
  })) as typeof window.matchMedia;
  const play = vi.fn(async () => {});
  document.querySelector("video")!.play = play;
  return play;
}

describe("playDemo", () => {
  it("plays the recording", () => {
    const play = render(false);
    playDemo();
    expect(play).toHaveBeenCalledOnce();
  });

  it("leaves it still for a reader who asked for less motion", () => {
    const play = render(true);
    playDemo();
    expect(play).not.toHaveBeenCalled();
  });

  it("lets a browser that refuses to autoplay leave it still", async () => {
    const play = render(false);
    play.mockRejectedValueOnce(new Error("NotAllowedError"));
    expect(() => playDemo()).not.toThrow();
    await Promise.resolve();
  });
});
