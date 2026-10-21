/** Examples: show the cards that match both the project and the result chosen. */
export function setUpFilters(): void {
  const state: Record<string, string> = { source: "", verdict: "" };
  const nav = document.querySelector<HTMLElement>(".filters")!;
  const examples = [...document.querySelectorAll<HTMLElement>(".example")];
  const empty = document.querySelector<HTMLElement>(".empty")!;
  nav.hidden = false;
  nav.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(
      "button[data-filter]",
    );
    if (!button) return;
    const filter = button.dataset.filter!;
    state[filter] = button.dataset.value!;
    for (const other of nav.querySelectorAll(
      `button[data-filter="${filter}"]`,
    )) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    let shown = 0;
    for (const example of examples) {
      const visible =
        (!state.source || example.dataset.source === state.source) &&
        (!state.verdict || example.dataset.verdict === state.verdict);
      example.hidden = !visible;
      if (visible) shown += 1;
    }
    empty.hidden = shown > 0;
  });
}
