import { describe, expect, it } from "vitest";

import { REPO } from "../frame.js";
import { renderMarkdown, sitePathOf, slugify } from "./markdown.js";

// docs/ is written for GitHub and rendered again for the site: the Markdown
// stays as it is, so the anchors GitHub makes and the links GitHub follows
// have to land in the same places on the site.

describe("slugify", () => {
  it.each([
    ["Scope & existing types", "scope--existing-types"],
    ["What `apply` will and won't do", "what-apply-will-and-wont-do"],
    [
      "Path A — `register` (zero-config, one shot)",
      "path-a--register-zero-config-one-shot",
    ],
    ["`infer.*`", "infer"],
    ["Use with Svelte 5", "use-with-svelte-5"],
  ])("makes the anchor GitHub makes for %s", (heading, slug) => {
    expect(slugify(heading)).toBe(slug);
  });
});

describe("sitePathOf", () => {
  it.each([
    ["README.md", "docs/"],
    ["how-to/check-your-types.md", "docs/how-to/check-your-types/"],
    ["reference/cli.md", "docs/reference/cli/"],
    ["examples/README.md", "examples/"],
  ])("puts %s at %s", (file, path) => {
    expect(sitePathOf(file)).toBe(path);
  });
});

describe("renderMarkdown", () => {
  const render = (source: string, file = "how-to/check-your-types.md") =>
    renderMarkdown(source, file);

  it("takes the title from the first heading", () => {
    expect(render("# Check the types you wrote\n\nText.\n").title).toBe(
      "Check the types you wrote",
    );
  });

  it("gives every heading the anchor GitHub gives it, and lists the second level", () => {
    const { html, headings } = render(
      "# Title\n\n## What `apply` will and won't do\n\n### Detail\n\n## Merge and verify\n",
    );
    expect(html).toContain(
      '<h2 id="what-apply-will-and-wont-do">What <code>apply</code> will and won&#39;t do</h2>',
    );
    expect(html).toContain('<h3 id="detail">Detail</h3>');
    expect(headings).toEqual([
      {
        id: "what-apply-will-and-wont-do",
        html: "What <code>apply</code> will and won&#39;t do",
      },
      { id: "merge-and-verify", html: "Merge and verify" },
    ]);
  });

  it("numbers a repeated heading the way GitHub does", () => {
    const { html } = render("## Notes\n\n## Notes\n");
    expect(html).toContain('<h2 id="notes">');
    expect(html).toContain('<h2 id="notes-1">');
  });

  describe("links", () => {
    const href = (markdown: string, file?: string): string =>
      /href="([^"]*)"/.exec(render(markdown, file).html)?.[1] ?? "";

    it("sends a link to another docs page to that page on the site", () => {
      expect(href("[cli](../reference/cli.md#ts-capture-verify)")).toBe(
        "../../reference/cli/#ts-capture-verify",
      );
      expect(href("[same folder](use-with-svelte.md)")).toBe(
        "../use-with-svelte/",
      );
      expect(href("[index](../README.md)")).toBe("../../");
    });

    it("resolves links from the index, which sits one level higher", () => {
      expect(href("[cli](reference/cli.md)", "README.md")).toBe(
        "reference/cli/",
      );
    });

    it("sends the examples note to the examples page", () => {
      expect(href("[Examples](../examples/README.md)")).toBe(
        "../../../examples/",
      );
    });

    it("sends a link out of docs/ to the file on GitHub", () => {
      expect(href("[vite](../../packages/vite)")).toBe(
        `${REPO}/tree/main/packages/vite`,
      );
      expect(href("[perf](../../README.md#performance)")).toBe(
        `${REPO}/blob/main/README.md#performance`,
      );
      expect(href("[data](examples.json)", "examples/README.md")).toBe(
        `${REPO}/blob/main/docs/examples/examples.json`,
      );
    });

    it("leaves anchors on the page and other sites alone", () => {
      expect(href("[below](#notes)")).toBe("#notes");
      expect(href("[d](https://diataxis.fr/)")).toBe("https://diataxis.fr/");
    });
  });

  describe("code blocks", () => {
    // Stands in for Shiki: colours `ts`, has no grammar for anything else.
    const highlight = (code: string, lang: string): string | undefined =>
      lang === "ts" ? `<b>${code}</b>` : undefined;

    it("hands a block to the highlighter by its language", () => {
      const { html } = renderMarkdown(
        '```ts title="Input"\nconst a = 1;\n```\n',
        "how-to/x.md",
        highlight,
      );
      expect(html).toContain("<pre><code><b>const a = 1;</b></code></pre>");
    });

    it("escapes a block the highlighter has no grammar for", () => {
      const { html } = renderMarkdown(
        "```sh\necho <a> && b\n```\n",
        "how-to/x.md",
        highlight,
      );
      expect(html).toContain(
        "<pre><code>echo &lt;a&gt; &amp;&amp; b</code></pre>",
      );
    });

    it("puts the title of a block above it", () => {
      const { html } = render('```text title="Current"\nok\n```\n');
      expect(html).toContain(
        "<figure><figcaption>Current</figcaption><pre><code>ok</code></pre></figure>",
      );
    });
  });
});
