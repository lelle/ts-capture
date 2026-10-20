import { Marked, type Tokens } from "marked";
import { posix } from "node:path";

import type { Highlight } from "./highlight.js";

import { escapeHtml } from "../code.js";
import { REPO } from "../frame.js";

export interface Heading {
  id: string;
  html: string;
  /** What the menu lists: a CLI command's name alone, else the heading. */
  menu: string;
}

export interface RenderedDoc {
  title: string;
  html: string;
  /** The second-level headings, in order: what the menu lists under the page. */
  headings: Heading[];
}

/** The anchor GitHub gives a heading, so links written for GitHub still land. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replaceAll(" ", "-");
}

/** Where a file under docs/ is served on the site, relative to its root. */
export function sitePathOf(file: string): string {
  if (file === "examples/README.md") return "examples/";
  if (file === "README.md") return "docs/";
  return `docs/${file.replace(/\.md$/, "")}/`;
}

/**
 * `file` is the page's path under docs/; it decides where its links lead.
 * Without `highlight`, code blocks are plain.
 */
export function renderMarkdown(
  source: string,
  file: string,
  highlight?: Highlight,
): RenderedDoc {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  let title = "";

  const marked = new Marked({
    renderer: {
      heading({ tokens, depth }) {
        const html = wholeWords(this.parser.parseInline(tokens));
        const text = unescapeHtml(html.replaceAll(/<[^>]*>/g, ""));
        const base = slugify(text);
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        const id = seen === 0 ? base : `${base}-${seen}`;
        if (depth === 1 && !title) title = text;
        if (depth === 2) {
          const [first, ...rest] = tokens;
          const command =
            first?.type === "codespan" &&
            /^ts-capture ([\w-]+)/.exec((first as Tokens.Codespan).text)?.[1];
          const menu = command
            ? `<code>${command}</code>${this.parser.parseInline(rest)}`
            : html;
          headings.push({ id, html, menu });
        }
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
      link({ href, title: linkTitle, tokens }) {
        const titled = linkTitle ? ` title="${escapeHtml(linkTitle)}"` : "";
        return `<a href="${escapeHtml(siteHref(href, file))}"${titled}>${this.parser.parseInline(tokens)}</a>`;
      },
      // Long names break at their own seams, not mid-word.
      codespan({ text }) {
        return `<code>${escapeHtml(text).replaceAll(/([./])/g, "$1<wbr>")}</code>`;
      },
      code({ text, lang }: Tokens.Code) {
        const info = lang ?? "";
        const language = /^\S*/.exec(info)![0];
        const caption = /\btitle="([^"]*)"/.exec(info)?.[1];
        const body = highlight?.(text, language) ?? escapeHtml(text);
        const pre = `<pre><code>${body}</code></pre>`;
        return caption === undefined
          ? `${pre}\n`
          : `<figure><figcaption>${escapeHtml(caption)}</figcaption>${pre}</figure>\n`;
      },
    },
  });

  const html = marked.parse(source, { async: false });
  return { title, html, headings };
}

// A signature in a heading breaks between its words: `[--` and `include-tests]`
// on two lines reads as two flags.
function wholeWords(html: string): string {
  return html.replaceAll(/<code>(.*?)<\/code>/g, (code, inner: string) =>
    inner.includes(" ")
      ? `<code>${inner
          .replaceAll("<wbr>", "")
          .replaceAll(
            /[^ ]+/g,
            (word) => `<span class="word">${word}</span>`,
          )}</code>`
      : code,
  );
}

/** A link from one site path to another, both relative to the site's root. */
export function relativeHref(from: string, to: string): string {
  const relative = posix.relative(`/${from}`, `/${to}`);
  return relative ? `${relative}/` : "./";
}

function siteHref(href: string, file: string): string {
  if (/^[a-z][a-z+.-]*:/i.test(href) || href.startsWith("#")) return href;
  const hashAt = href.indexOf("#");
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const inRepo = posix.normalize(posix.join("docs", posix.dirname(file), path));

  if (inRepo.startsWith("docs/") && inRepo.endsWith(".md")) {
    return `${relativeHref(sitePathOf(file), sitePathOf(inRepo.slice("docs/".length)))}${hash}`;
  }
  const kind = posix.extname(inRepo) ? "blob" : "tree";
  return `${REPO}/${kind}/main/${inRepo}${hash}`;
}

const ENTITIES: Record<string, string> = {
  "&#39;": "'",
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
};

function unescapeHtml(text: string): string {
  return text.replaceAll(
    /&(?:#39|amp|gt|lt|quot);/g,
    (entity) => ENTITIES[entity]!,
  );
}
