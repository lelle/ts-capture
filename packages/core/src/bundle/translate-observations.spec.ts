import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { BundleObservation } from "./instrument-bundle.js";

import { translateBundleObservations } from "./translate-observations.js";

// Build a synthetic source map by hand: source-map's Generator API would
// also work, but for unit testing translate-observations we just need a
// minimal valid map that round-trips one position.

async function withTmpFiles(
  setup: (dir: string) => void,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-trans-"));
  try {
    setup(dir);
    await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe("translateBundleObservations", () => {
  it("translates an observation through a basic source map", async () => {
    // Build a tiny synthetic case: bundle has 'function add(a, b) { return a + b; }'
    // on line 1; source has the same function at line 4 col 22.
    // We'll synthesize a source map that maps bundle (1,13) -> source (1,13).
    await withTmpFiles(
      (dir) => {
        fs.writeFileSync(path.join(dir, "src.ts"), "function add(a, b) { return a + b; }\n");
      },
      async (dir) => {
        const bundleSource = "function add(a, b) { return a + b; }\n";
        // Minimal source map: VLQ encoding for (1,13) -> (src.ts, 1, 13) would
        // be complex; use the source-map package's SourceMapGenerator.
        const { SourceMapGenerator } = await import("source-map");
        const gen = new SourceMapGenerator({ file: "bundle.js" });
        gen.addMapping({
          source: "src.ts",
          original: { line: 1, column: 13 },
          generated: { line: 1, column: 13 },
        });
        const mapJson = JSON.parse(gen.toString());

        const observations: BundleObservation[] = [
          { name: "a", pos: 13, file: path.join(dir, "bundle.js"), type: "number" },
        ];

        const r = await translateBundleObservations(observations, bundleSource, mapJson, {
          sourceRoot: dir,
        });
        expect(r.unmapped).toHaveLength(0);
        expect(r.missingSource).toHaveLength(0);
        expect(r.typeInfo).toHaveLength(1);
        const [filePath, offset, types] = r.typeInfo[0];
        expect(filePath).toBe(path.join(dir, "src.ts"));
        // Insert offset = position of "a" (13) + name length (1) = 14
        expect(offset).toBe(14);
        expect(types).toEqual([["number", undefined]]);
      },
    );
  });

  it("recovers parameter names from source for minified bundles", async () => {
    // Bundle has `function add(r,e){return r+e}` (minified) but source
    // still has `function add(a, b) { return a + b; }`.
    // We map bundle pos to source pos and recover name from source.
    await withTmpFiles(
      (dir) => {
        fs.writeFileSync(path.join(dir, "src.ts"), "function add(a, b) { return a + b; }\n");
      },
      async (dir) => {
        const bundleSource = "function add(r,e){return r+e}\n";
        const { SourceMapGenerator } = await import("source-map");
        const gen = new SourceMapGenerator({ file: "bundle.js" });
        gen.addMapping({
          source: "src.ts",
          original: { line: 1, column: 13 },
          generated: { line: 1, column: 13 },
        });
        const mapJson = JSON.parse(gen.toString());

        const observations: BundleObservation[] = [
          { name: "r", pos: 13, file: path.join(dir, "bundle.js"), type: "number" },
        ];
        const r = await translateBundleObservations(observations, bundleSource, mapJson, {
          sourceRoot: dir,
        });
        expect(r.typeInfo).toHaveLength(1);
        const [, offset, types] = r.typeInfo[0];
        // Recovered name in source is "a" (length 1), inserted at 13 + 1 = 14
        expect(offset).toBe(14);
        expect(types).toEqual([["number", undefined]]);
      },
    );
  });

  it("reports unmapped observations when source-map has no entry", async () => {
    const bundleSource = "function add(a, b) { return a + b; }\n";
    const { SourceMapGenerator } = await import("source-map");
    const gen = new SourceMapGenerator({ file: "bundle.js" });
    // No mappings added
    const observations: BundleObservation[] = [
      { name: "a", pos: 13, file: "/tmp/bundle.js", type: "number" },
    ];
    const r = await translateBundleObservations(
      observations,
      bundleSource,
      JSON.parse(gen.toString()),
    );
    expect(r.unmapped).toHaveLength(1);
    expect(r.typeInfo).toHaveLength(0);
  });

  it("groups multiple observations at the same source position", async () => {
    await withTmpFiles(
      (dir) => {
        fs.writeFileSync(path.join(dir, "src.ts"), "function f(x) { return x; }\n");
      },
      async (dir) => {
        const bundleSource = "function f(x) { return x; }\n";
        const { SourceMapGenerator } = await import("source-map");
        const gen = new SourceMapGenerator({ file: "bundle.js" });
        gen.addMapping({
          source: "src.ts",
          original: { line: 1, column: 11 },
          generated: { line: 1, column: 11 },
        });
        const mapJson = JSON.parse(gen.toString());

        const observations: BundleObservation[] = [
          { name: "x", pos: 11, file: path.join(dir, "bundle.js"), type: "string" },
          { name: "x", pos: 11, file: path.join(dir, "bundle.js"), type: "number" },
        ];
        const r = await translateBundleObservations(observations, bundleSource, mapJson, {
          sourceRoot: dir,
        });
        expect(r.typeInfo).toHaveLength(1);
        const [, , types] = r.typeInfo[0];
        // Two distinct observed types merged into one entry
        expect(types).toHaveLength(2);
      },
    );
  });

  it("strips webpack:// URL scheme from source map paths", async () => {
    await withTmpFiles(
      (dir) => {
        fs.writeFileSync(path.join(dir, "src.ts"), "function f(x) { return x; }\n");
      },
      async (dir) => {
        const bundleSource = "function f(x) { return x; }\n";
        const { SourceMapGenerator } = await import("source-map");
        const gen = new SourceMapGenerator({ file: "bundle.js" });
        gen.addMapping({
          source: "webpack://my-project/src.ts",
          original: { line: 1, column: 11 },
          generated: { line: 1, column: 11 },
        });
        const mapJson = JSON.parse(gen.toString());

        const observations: BundleObservation[] = [
          { name: "x", pos: 11, file: path.join(dir, "bundle.js"), type: "string" },
        ];
        const r = await translateBundleObservations(observations, bundleSource, mapJson, {
          sourceRoot: dir,
        });
        expect(r.typeInfo).toHaveLength(1);
        expect(r.typeInfo[0][0]).toBe(path.join(dir, "src.ts"));
      },
    );
  });
});
