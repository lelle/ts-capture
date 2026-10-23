import { atPageBottom, onScrollFrame } from "./scroll.js";

// The rule being read is the last whose heading has passed the top, or the
// last at the bottom of the page. On a narrow screen the menu folds behind a
// bar that names it.

/** How it decides: the rules menu beside the page. */
export function setUpRulesToc(): void {
  const toc = document.querySelector<HTMLElement>(".toc")!;
  const toggle = toc.querySelector<HTMLButtonElement>(".toc-toggle")!;
  const current = toc.querySelector<HTMLElement>(".toc-current")!;
  const links = [...toc.querySelectorAll<HTMLAnchorElement>(".toc-list a")];
  const targets = links.map((link) =>
    document.getElementById(decodeURIComponent(link.hash.slice(1))),
  );
  const fold = (open: boolean): void => {
    toggle.setAttribute("aria-expanded", String(open));
    toc.classList.toggle("open", open);
  };
  toggle.addEventListener("click", () =>
    fold(toggle.getAttribute("aria-expanded") !== "true"),
  );
  for (const link of links) link.addEventListener("click", () => fold(false));
  const update = (): void => {
    let at = -1;
    targets.forEach((target, i) => {
      if (target && target.getBoundingClientRect().top <= 80) at = i;
    });
    if (atPageBottom()) at = targets.length - 1;
    links.forEach((link, i) => link.classList.toggle("on-screen", i === at));
    current.textContent = links[at]?.textContent ?? "Rules";
  };
  onScrollFrame(update);
  update();
}
