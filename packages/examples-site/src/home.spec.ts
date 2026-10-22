import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { INTEGRATIONS, renderHomePage } from "./home.js";

describe("renderHomePage", () => {
  const html = renderHomePage({ version: "0.4.0" });

  it("links to the examples and the playground beside it", () => {
    expect(html).toContain('<a href="examples/">');
    expect(html).toContain('<a href="playground/">');
  });

  const shown = (): string => /<img class="shown"[^>]*>/.exec(html)?.[0] ?? "";
  const steps = (): string[] =>
    [...html.matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]!);

  it("shows the first step large, sharp on a dense screen, with a text alternative", () => {
    expect(shown()).toContain('src="demo-1.webp"');
    expect(shown()).toContain('srcset="demo-1@2x.webp 2x"');
    expect(shown()).toMatch(/alt="[^"]+"/);
    const described = /aria-describedby="([^"]+)"/.exec(shown())?.[1];
    expect(html).toContain(`id="${described}"`);
  });

  it("offers the five steps under it, each a link to its full-size still, the first marked", () => {
    expect(steps()).toEqual([1, 2, 3, 4, 5].map((n) => `demo-${n}@2x.webp`));
    expect(html).toMatch(/<a href="demo-1@2x.webp" aria-current="step">/);
  });

  it("names only stills the recording wrote", () => {
    const assets = resolve(import.meta.dirname, "../../../docs/assets");
    const named = [...html.matchAll(/"(demo-[^" ]+\.webp)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const file of named)
      expect(existsSync(resolve(assets, file))).toBe(true);
  });

  it("leaves turning the steps to the script, so reduced motion can keep them still", () => {
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
