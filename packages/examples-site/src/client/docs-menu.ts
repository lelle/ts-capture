import { beingRead, onScrollFrame } from "./scroll.js";

// Open in the HTML, so the menu is there without a script; folded on a narrow
// screen, where it would push the page down. The section being read is the
// last one whose heading has passed the top, or the last at the bottom.

/** Docs: the menu beside the page. */
export function setUpDocsMenu(): void {
  const menu = document.querySelector<HTMLDetailsElement>(".docs-menu")!;
  const narrow = matchMedia("(max-width: 900px)");
  if (narrow.matches) menu.open = false;
  // Folded before the jump, so it lands where the page is once the menu is closed.
  menu.addEventListener("click", (event) => {
    if (narrow.matches && (event.target as Element).closest("nav a")) {
      menu.open = false;
    }
  });
  const links = [...menu.querySelectorAll<HTMLAnchorElement>(".sections a")];
  const targets = links.map((link) =>
    document.getElementById(decodeURIComponent(link.hash.slice(1))),
  );
  const update = (): void => {
    const at = beingRead(targets);
    links.forEach((link, i) => link.classList.toggle("on-screen", i === at));
  };
  onScrollFrame(update);
  update();
}

/** Docs: a copy button on every block marked to copy. */
export function setUpCopyButtons(): void {
  for (const pre of document.querySelectorAll("pre[data-copy]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(pre.querySelector("code")!.textContent)
        .then(() => {
          button.textContent = "Copied";
          setTimeout(() => (button.textContent = "Copy"), 1500);
        });
    });
    pre.append(button);
  }
}
