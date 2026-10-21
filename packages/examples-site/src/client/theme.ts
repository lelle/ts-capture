// A page follows the system until the reader picks a theme; the pick is kept
// in this browser, and set from <head>, so the page is never drawn in the
// other theme first. Storage can be blocked: the switch then still works for
// the page in front of the reader.

type Theme = "dark" | "light";

const KEY = "theme";
const root = document.documentElement;

/** Before the page is drawn: the theme the reader picked, if they did. */
export function applySavedTheme(): void {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") root.dataset.theme = saved;
  } catch {
    // Storage is blocked: the page follows the system.
  }
}

/** The bar's switch, offering the theme the page is not in. */
export function setUpThemeSwitch(): void {
  const button = document.querySelector<HTMLButtonElement>("button.theme")!;
  const current = (): Theme =>
    (root.dataset.theme as Theme | undefined) ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const other = (): Theme => (current() === "dark" ? "light" : "dark");
  const show = (): void => {
    const next = other();
    button.setAttribute("aria-label", `Switch to ${next} theme`);
    for (const icon of button.querySelectorAll("svg")) {
      icon.toggleAttribute("hidden", !icon.classList.contains(`to-${next}`));
    }
  };
  button.addEventListener("click", () => {
    const next = other();
    root.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Kept for this page only.
    }
    show();
  });
  show();
  button.hidden = false;
}
