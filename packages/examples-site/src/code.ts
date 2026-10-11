import { markAdded, tokenize } from "./tokens.js";

const ENTITIES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(text: string): string {
  return text.replaceAll(/["&'<>]/g, (character) => ENTITIES[character]);
}

/** `after` as highlighted HTML, with what `before` does not have wrapped in `ins`. */
export function renderCode(before: string, after: string): string {
  let html = "";
  let inAdded = false;
  for (const token of markAdded(tokenize(before), tokenize(after))) {
    if (token.added !== inAdded) {
      html += token.added ? "<ins>" : "</ins>";
      inAdded = token.added;
    }
    const text = escapeHtml(token.text);
    html +=
      token.kind === "space" || token.kind === "punctuation"
        ? text
        : `<span class="t-${token.kind}">${text}</span>`;
  }
  return inAdded ? `${html}</ins>` : html;
}
