// The recording is five stills. The large one turns every few seconds until
// the reader picks a step; a reader who asked for less motion picks alone.
// Without the script each step is a link to its full-size still.

const TURN = 4000;

/** Home: the recording's steps, one large, picked from the row under it. */
export function setUpDemo(): void {
  const shown = document.querySelector<HTMLImageElement>(".demo img.shown")!;
  const steps = [
    ...document.querySelectorAll<HTMLAnchorElement>(".demo .steps a"),
  ];
  let at = 0;
  const show = (i: number): void => {
    at = i;
    const step = steps[i]!;
    shown.src = step.querySelector("img")!.getAttribute("src")!;
    shown.srcset = `${step.getAttribute("href")!} 2x`;
    shown.alt = step.textContent.trim();
    steps.forEach((other, j) => {
      if (j === i) other.setAttribute("aria-current", "step");
      else other.removeAttribute("aria-current");
    });
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    timer = setInterval(() => show((at + 1) % steps.length), TURN);
  }
  steps.forEach((step, i) => {
    step.addEventListener("click", (event) => {
      event.preventDefault();
      clearInterval(timer);
      show(i);
    });
  });
}
