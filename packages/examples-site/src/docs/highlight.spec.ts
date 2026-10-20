import { beforeAll, describe, expect, it } from "vitest";

import { createCodeHighlighter, type Highlight } from "./highlight.js";

// Docs code goes through Shiki's grammars, and comes out in the site's own
// token classes, so it reads the same as the code on Examples and Playground.

let highlight: Highlight;
beforeAll(async () => {
  highlight = await createCodeHighlighter();
});

describe("createCodeHighlighter", () => {
  it("colours TypeScript as the rest of the site does", () => {
    const html = highlight('const a: string = f("x", 1); // c', "ts")!;
    expect(html).toContain('<span class="t-keyword">const</span>');
    expect(html).toContain('<span class="t-type">string</span>');
    expect(html).toContain('<span class="t-string">&quot;x&quot;</span>');
    expect(html).toContain('<span class="t-number">1</span>');
    expect(html).toContain('<span class="t-comment">// c</span>');
  });

  it("colours a shell command: its comment, command, option and quoted text", () => {
    const html = highlight('# c\nnpx vitest run --threshold=1 "s"', "sh")!;
    expect(html).toContain('<span class="t-comment"># c</span>');
    expect(html).toContain('<span class="t-keyword">npx</span>');
    expect(html).toContain('<span class="t-type">--threshold=1</span>');
    expect(html).toContain('<span class="t-string">&quot;s&quot;</span>');
    expect(html).toContain(" vitest run ");
  });

  it("colours JSON values, and leaves its keys plain", () => {
    const html = highlight('{ "a": [1, "s", true] }', "json")!;
    expect(html).toContain("{ &quot;a&quot;: [");
    expect(html).toContain('<span class="t-number">1</span>');
    expect(html).toContain('<span class="t-string">&quot;s&quot;</span>');
    expect(html).toContain('<span class="t-keyword">true</span>');
  });

  it("marks the lines a diff adds and removes", () => {
    const html = highlight("-a\n+b", "diff")!;
    expect(html).toBe(
      '<span class="t-deleted">-a</span>\n<span class="t-inserted">+b</span>',
    );
  });

  it("colours markup in TSX and Svelte", () => {
    expect(highlight('const e = <div className="x" />;', "tsx")).toContain(
      '<span class="t-keyword">div</span>',
    );
    expect(highlight("<p>{n}</p>", "svelte")).toContain(
      '<span class="t-keyword">p</span>',
    );
  });

  it("escapes what it writes", () => {
    expect(highlight("a < b && c", "ts")).toContain("&lt;");
    expect(highlight("a < b && c", "ts")).toContain("&amp;&amp;");
  });

  it("has nothing to say about a language it has no grammar for", () => {
    expect(highlight("node_modules/", "gitignore")).toBeUndefined();
    expect(highlight("plain", "text")).toBeUndefined();
  });
});
