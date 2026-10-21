import { escapeHtml, type Markup, trusted } from "./markup.js";
import { markAdded, tokenize } from "./tokens.js";

/** `after` as highlighted HTML, with what `before` does not have wrapped in `ins`. */
export function renderCode(before: string, after: string): Markup {
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
  return trusted(inAdded ? `${html}</ins>` : html);
}
