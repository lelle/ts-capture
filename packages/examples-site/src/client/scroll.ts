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

/**
 * Which of `targets`, in page order, is being read: the last whose top has
 * passed near the top of the window, or the last at the end of the page.
 */
export function beingRead(targets: readonly (HTMLElement | null)[]): number {
  if (atPageBottom()) return targets.length - 1;
  let at = -1;
  targets.forEach((target, i) => {
    if (target && target.getBoundingClientRect().top <= 80) at = i;
  });
  return at;
}

/** At the end of the page, where the last section can never reach the top. */
export function atPageBottom(): boolean {
  return innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
}
