import { atPageBottom, onScrollFrame } from "./scroll.js";

// The selected kind is the kind of the card being read, or of the card a click
// pinned while that card is on screen; at the bottom of the page, the last
// card. Outcome marks the selected kind's cards on screen. On a narrow screen
// the menu folds behind a bar that names the card being read.

/** How it decides: the kind and outcome menu beside the cards. */
export function setUpToc(): void {
  const toc = document.querySelector<HTMLElement>(".toc")!;
  const toggle = toc.querySelector<HTMLButtonElement>(".toc-toggle")!;
  const current = toc.querySelector<HTMLElement>(".toc-current")!;
  const heading = document.getElementById("outcome-heading")!;
  const kindLinks = [
    ...document.querySelectorAll<HTMLAnchorElement>("#kinds a"),
  ];
  const outcomeLinks = [
    ...document.querySelectorAll<HTMLAnchorElement>("#outcomes a"),
  ];
  const cards = [...document.querySelectorAll<HTMLElement>("main .example")];
  const ids = cards.map((card) => card.id);
  const kindOf = (id: string): string => id.slice(0, id.indexOf("-"));
  const titleOf = (id: string): string =>
    kindLinks.find((link) => link.dataset.kind === kindOf(id))!.textContent +
    " · " +
    id.slice(id.indexOf("-") + 1);
  const fold = (open: boolean): void => {
    toggle.setAttribute("aria-expanded", String(open));
    toc.classList.toggle("open", open);
  };
  toggle.addEventListener("click", () =>
    fold(toggle.getAttribute("aria-expanded") !== "true"),
  );
  // On a narrow screen the folded menu is a bar over the top of the page: what
  // is under it is not on screen.
  const bar = (): number =>
    getComputedStyle(toggle).display === "none" ? 0 : toc.offsetHeight;
  let pinned: string | null = null;
  let arriving = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const go = (id: string): void => {
    // Fold first: open, the menu pushes the page down on a narrow screen, and a
    // jump measured with it open lands one menu too far once it closes.
    fold(false);
    pinned = id;
    arriving = true;
    clearTimeout(settle);
    settle = setTimeout(() => {
      arriving = false;
      update();
    }, 1200);
    document.getElementById(id)!.scrollIntoView({ behavior: "smooth" });
    history.replaceState(null, "", "#" + id);
    update();
  };
  for (const link of kindLinks) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      go(link.dataset.kind + "-" + link.dataset.outcomes!.split(" ")[0]);
    });
  }
  for (const link of outcomeLinks) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      if (link.getAttribute("aria-disabled") !== "true") {
        go(selected + "-" + link.dataset.outcome);
      }
    });
  }
  let selected = kindLinks[0]?.dataset.kind;
  const select = (kind: string): void => {
    if (kind === selected) return;
    selected = kind;
    const has = new Set<string>();
    for (const link of kindLinks) {
      const on = link.dataset.kind === kind;
      link.toggleAttribute("aria-current", on);
      if (on) {
        heading.textContent = "Outcome — " + link.textContent;
        for (const outcome of link.dataset.outcomes!.split(" ")) {
          has.add(outcome);
        }
      }
    }
    for (const link of outcomeLinks) {
      if (has.has(link.dataset.outcome!)) {
        link.href = "#" + kind + "-" + link.dataset.outcome;
        link.removeAttribute("aria-disabled");
      } else {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
      }
    }
  };
  // The observer only says which cards are near the screen. Whether one shows
  // more than a sliver is measured from where it is now, every frame the page
  // scrolls: an observer reports a card once, as it crosses the edge, and a
  // card that crossed by two pixels during a fast scroll would never count.
  const near = new Set<string>();
  const update = (): void => {
    const top = bar();
    const onScreen = new Set<string>();
    for (const id of near) {
      const r = document.getElementById(id)!.getBoundingClientRect();
      if (Math.min(r.bottom, innerHeight) - Math.max(r.top, top) > 4) {
        onScreen.add(id);
      }
    }
    if (pinned && !onScreen.has(pinned) && !arriving) pinned = null;
    const shown = ids.filter((id) => onScreen.has(id));
    let reading: string | undefined =
      shown.find(
        (id) =>
          document.getElementById(id)!.getBoundingClientRect().bottom >
          top + 80,
      ) ?? shown[0];
    // At the bottom the last card is read, unless a click pinned another.
    if (atPageBottom() && !pinned) reading = ids.at(-1);
    const shownFor = pinned ?? reading;
    if (shownFor) select(kindOf(shownFor));
    for (const link of outcomeLinks) {
      link.classList.toggle(
        "on-screen",
        onScreen.has(selected + "-" + link.dataset.outcome),
      );
    }
    if (shownFor) current.textContent = titleOf(shownFor);
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) near.add(entry.target.id);
      else near.delete(entry.target.id);
    }
    update();
  });
  onScrollFrame(update);
  for (const card of cards) observer.observe(card);
}
