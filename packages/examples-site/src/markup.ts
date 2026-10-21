import { escapeHtml } from "./code.js";

// Not named `html`: Prettier formats templates tagged `html` as HTML, which
// would change what the pages send, inside `<pre>` too.

/** Text that is HTML already: made by `markup`, or marked with `trusted`. */
export class Markup {
  constructor(readonly text: string) {}

  toString(): string {
    return this.text;
  }
}

type Value = Markup | Value[] | false | null | number | string | undefined;

/** HTML with every value put into it escaped, unless it is `Markup` already. */
export function markup(
  strings: TemplateStringsArray,
  ...values: Value[]
): Markup {
  let text = strings[0]!;
  values.forEach((value, i) => {
    text += render(value) + strings[i + 1]!;
  });
  return new Markup(text);
}

/** Marks text as HTML, where it is made by code that escapes as it goes. */
export function trusted(text: string): Markup {
  return new Markup(text);
}

function render(value: Value): string {
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === false || value === null || value === undefined) return "";
  return escapeHtml(String(value));
}
