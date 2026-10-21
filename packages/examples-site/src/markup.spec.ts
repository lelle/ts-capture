import { describe, expect, it } from "vitest";

import { join, markup, trusted } from "./markup.js";

// Every value put into a page goes through the tag, so a value nobody thought
// to escape is escaped anyway; only what is marked as HTML goes in as HTML.

describe("markup", () => {
  it("escapes text put into it", () => {
    const name = `<b>"Tom" & 'Jerry'</b>`;
    expect(String(markup`<p title="${name}">${name}</p>`)).toBe(
      '<p title="&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;">&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;</p>',
    );
  });

  it("puts HTML it made in as it is", () => {
    const item = markup`<li>${"a < b"}</li>`;
    expect(String(markup`<ul>${item}</ul>`)).toBe("<ul><li>a &lt; b</li></ul>");
  });

  it("puts HTML marked as trusted in as it is", () => {
    expect(String(markup`<pre>${trusted("<span>x</span>")}</pre>`)).toBe(
      "<pre><span>x</span></pre>",
    );
  });

  it("joins a list, escaping each text in it", () => {
    const items = ["<a>", "b"].map((name) => markup`<li>${name}</li>`);
    expect(String(markup`<ul>${items}</ul>`)).toBe(
      "<ul><li>&lt;a&gt;</li><li>b</li></ul>",
    );
    expect(String(markup`${["<a>", markup`<b>`]}`)).toBe("&lt;a&gt;<b>");
  });

  it("writes numbers, and nothing for a condition that did not hold", () => {
    const shown = false;
    expect(
      String(
        markup`<p>${3}${shown && markup`<i>no</i>`}${null}${undefined}</p>`,
      ),
    ).toBe("<p>3</p>");
  });
});

describe("join", () => {
  it("puts the separator between the items, as text", () => {
    const items = ["a", "<b>"].map((name) => markup`<li>${name}</li>`);
    expect(String(join(items, "\n"))).toBe("<li>a</li>\n<li>&lt;b&gt;</li>");
    expect(String(join([], "\n"))).toBe("");
  });
});
