/** Runs `update` at most once a frame while the page scrolls. */
export function onScrollFrame(update: () => void): void {
  let frame = 0;
  addEventListener(
    "scroll",
    () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
      }
    },
    { passive: true },
  );
}

/** At the end of the page, where the last section can never reach the top. */
export function atPageBottom(): boolean {
  return innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
}
