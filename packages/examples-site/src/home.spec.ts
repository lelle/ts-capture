import { describe, expect, it } from "vitest";

import { INTEGRATIONS, renderHomePage } from "./home.js";

describe("renderHomePage", () => {
  const html = renderHomePage({ version: "0.4.0" });

  it("links to the examples and the playground beside it", () => {
    expect(html).toContain('<a href="examples/">');
    expect(html).toContain('<a href="playground/">');
  });

  it("plays the recording muted and inline, with a text alternative", () => {
    const video = /<video\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(video).toContain('src="demo.mp4"');
    for (const attribute of ["muted", "loop", "playsinline", "controls"]) {
      expect(video).toMatch(new RegExp(`\\s${attribute}[\\s>]`));
    }
    const described = /aria-describedby="([^"]+)"/.exec(video)?.[1];
    expect(html).toContain(`id="${described}"`);
  });

  it("leaves starting the recording to the script, so reduced motion can keep it still", () => {
    const video = /<video\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(video).not.toMatch(/\sautoplay[\s>]/);
    expect(html).toContain('<script type="module" src="js/home.js"></script>');
  });

  it("gives each integration its install command and a link to its guide", () => {
    for (const integration of INTEGRATIONS) {
      const command = `npm install --save-dev ${integration.packages.join(" ")}`;
      expect(html.replaceAll(/<\/?span[^>]*>/g, "")).toContain(command);
      expect(html).toContain(`href="${integration.guide}"`);
    }
  });

  it("keeps each package name on one line", () => {
    for (const name of new Set(INTEGRATIONS.flatMap((i) => i.packages))) {
      expect(html).toContain(`<span class="package">${name}</span>`);
    }
  });

  it("points an already typed codebase to checking its types with verify", () => {
    expect(html).toContain("TS_CAPTURE_OBSERVE_ANNOTATED=1");
    expect(html).toContain('href="docs/how-to/check-your-types/"');
  });

  it("names the integration in each guide link, so the links differ when read out of context", () => {
    const labels = [...html.matchAll(/aria-label="([^"]+ guide)"/g)].map(
      (m) => m[1],
    );
    expect(labels).toEqual(INTEGRATIONS.map((i) => `${i.name} guide`));
  });
});
