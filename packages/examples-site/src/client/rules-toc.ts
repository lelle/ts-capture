import { atPageBottom, onScrollFrame } from "./scroll.js";

// What is being read is the last rule or example whose heading has passed the
// top, or the last at the bottom of the page; only its rule shows its examples.
// On a narrow screen the menu folds behind a bar that names the rule.

/** How it decides: the rules menu beside the page. */
export function setUpRulesToc(): void {
  const toc = document.querySelector<HTMLElement>(".toc")!;
  const toggle = toc.querySelector<HTMLButtonElement>(".toc-toggle")!;
  const current = toc.querySelector<HTMLElement>(".toc-current")!;
  const list = toc.querySelector<HTMLElement>(".toc-list")!;
  const links = [...list.querySelectorAll<HTMLAnchorElement>("a")];
  const targets = links.map((link) =>
    document.getElementById(decodeURIComponent(link.hash.slice(1))),
  );
  // Only as far as it takes, and only when the mark moves: a menu scrolled by
  // hand stays put.
  const reveal = (link: HTMLAnchorElement | undefined): void => {
    if (!link) return;
    const box = list.getBoundingClientRect();
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, window.innerHeight);
    const at = link.getBoundingClientRect();
    if (at.top < top) list.scrollTop -= top - at.top;
    else if (at.bottom > bottom) list.scrollTop += at.bottom - bottom;
  };
  let marked = -1;
  const fold = (open: boolean): void => {
    toggle.setAttribute("aria-expanded", String(open));
    toc.classList.toggle("open", open);
    if (open) reveal(links[marked]);
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
    const rule = links[at]?.closest(".toc-list > ul > li");
    for (const item of list.querySelectorAll(".toc-list > ul > li")) {
      item.classList.toggle("open", item === rule);
    }
    current.textContent =
      rule?.querySelector(":scope > a")?.textContent ?? "Rules";
    if (at !== marked) {
      marked = at;
      reveal(links[at]);
    }
  };
  onScrollFrame(update);
  update();
}
