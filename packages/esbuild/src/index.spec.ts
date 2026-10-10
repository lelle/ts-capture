import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspected,
  type Instrumented,
} from "../../core/src/test-utils/instrumented.js";
import "../../core/src/test-utils/matchers.js";
import {
  tsCaptureEsbuildPlugin,
  type TsCaptureEsbuildPluginOptions,
} from "./index.js";

// esbuild plugins only execute under build() — `transform()` is a single-
// file no-plugin code path. Every test below writes the source to a real
// file in a per-suite tempdir, then runs build({ write: false }) so the
// plugin's onLoad reads from disk (matching production behavior) while
// we keep test isolation cheap.

describe("@ts-capture/esbuild", () => {
  let tmpDir: string;

  beforeAll(() => {
    // esbuild hands the plugin real paths, and the system tmpdir can be a symlink.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-esbuild-test-")),
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function buildSource(
    source: string,
    opts: {
      filename?: string;
      pluginOpts?: TsCaptureEsbuildPluginOptions;
    } = {},
  ): Promise<Instrumented> {
    const filename = opts.filename ?? "test.ts";
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, source);
    const result = await esbuild.build({
      entryPoints: [filepath],
      bundle: false,
      write: false,
      platform: "node",
      format: "cjs",
      outdir: tmpDir,
      plugins: [tsCaptureEsbuildPlugin(opts.pluginOpts ?? {})],
    });
    if (result.outputFiles.length === 0) {
      throw new Error("esbuild produced no output files");
    }
    // esbuild rewrites the module around the calls, so the output is held to
    // parsing and to each call recording at a site of the source, not to
    // being the source plus calls.
    return inspected(result.outputFiles[0].text, { input: source, filename });
  }

  const pathOf = (filename: string): string => path.join(tmpDir, filename);

  it("instruments untyped function parameters in .ts files", async () => {
    const output = await buildSource(
      `export function greet(name) { return "Hello " + name; }`,
    );
    expect(output).toTrack("name", { in: pathOf("test.ts") });
    expect(output).toWrapReturnOf("greet");
  });

  it("does not instrument .js files (only TS extensions pass the filter)", async () => {
    const output = await buildSource(`export function f(x) { return x + 1; }`, {
      filename: "passthrough.js",
    });
    expect(output.calls).toEqual([]);
  });

  it("respects exclude regex", async () => {
    const output = await buildSource(`export function f(x) { return x; }`, {
      filename: "excluded.ts",
      pluginOpts: { exclude: /excluded/ },
    });
    expect(output.calls).toEqual([]);
  });

  it("include regex acts as whitelist — matching files instrument", async () => {
    const matched = await buildSource(`export function f(x) { return x; }`, {
      filename: "yes-pattern.ts",
      pluginOpts: { include: /yes-pattern/ },
    });
    expect(matched).toTrack("x", { in: pathOf("yes-pattern.ts") });
  });

  it("include regex acts as whitelist — non-matching files pass through", async () => {
    const skipped = await buildSource(`export function f(x) { return x; }`, {
      filename: "other-pattern.ts",
      pluginOpts: { include: /yes-pattern/ },
    });
    expect(skipped.calls).toEqual([]);
  });

  it("handles .tsx files via the tsx loader (JSX transpiled)", async () => {
    const output = await buildSource(
      `export const Greet = (props) => <div>{props.name}</div>;`,
      { filename: "Greet.tsx" },
    );
    expect(output).toTrack("props", { arrow: true });
    expect(output).toWrapReturnOf("Greet");
    // esbuild's default JSX transform emits `React.createElement` (classic
    // runtime). If this changes upstream, accept any of the well-known
    // forms — we only care that the JSX was actually transpiled, proving
    // the tsx loader path executed.
    expect(output.text).toMatch(/createElement|_jsx|h\(/);
  });

  it("injectRuntime prepends require to an entry file", async () => {
    const output = await buildSource(`export function f(x) { return x; }`, {
      filename: "entry.ts",
      pluginOpts: { injectRuntime: true },
    });
    expect(output.text).toMatch(
      /require\(["']@ts-capture\/core\/preload["']\)/,
    );
    expect(output).toTrack("x");
  });

  it("injectRuntime omits the require when option is false (default)", async () => {
    const output = await buildSource(`export function f(x) { return x; }`, {
      filename: "no-inject.ts",
      pluginOpts: { injectRuntime: false },
    });
    expect(output.text).not.toMatch(
      /require\(["']@ts-capture\/core\/preload["']\)/,
    );
    expect(output).toTrack("x");
  });

  it("injectRuntime only touches entry files, not bundled imports", async () => {
    // Two files; bundle them into one. Both go through onLoad so both
    // get instrumented, but only the entry should carry the runtime
    // require. Verifies the entry-set membership check in the plugin.
    const entry = path.join(tmpDir, "inject-entry.ts");
    const helper = path.join(tmpDir, "inject-helper.ts");
    fs.writeFileSync(helper, `export function helper(x) { return x * 2; }`);
    fs.writeFileSync(
      entry,
      `import { helper } from "./inject-helper"; export function main(x) { return helper(x); }`,
    );

    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      outdir: tmpDir,
      // `@ts-capture/core/preload` is a peer dep of consumers; in production
      // tsup configs it lives in `external` (or is pulled from
      // node_modules at run-time via the require). Treating it the
      // same here keeps the bundle resolvable without a fake fixture.
      external: ["@ts-capture/core/preload"],
      plugins: [tsCaptureEsbuildPlugin({ injectRuntime: true })],
    });
    const output = result.outputFiles[0].text;

    // Both files are instrumented.
    const out = inspected(output);
    expect(out).toTrack("x", { in: entry });
    expect(out).toTrack("x", { in: helper });

    // Only ONE runtime require — the entry's. The bundled helper must
    // not have its own (would be redundant after Node's module cache).
    const requireCount = (
      output.match(/require\(["']@ts-capture\/core\/preload["']\)/g) ?? []
    ).length;
    expect(requireCount).toBe(1);
  });

  it("handles entryPoints in object form (name → input map)", async () => {
    // tsup and some esbuild configs use this shape. Plugin must
    // normalize it correctly when collecting entry paths.
    const entry = path.join(tmpDir, "obj-entry.ts");
    fs.writeFileSync(entry, `export function f(x) { return x; }`);
    const result = await esbuild.build({
      entryPoints: { "named-out": entry },
      bundle: false,
      write: false,
      platform: "node",
      format: "cjs",
      outdir: tmpDir,
      plugins: [tsCaptureEsbuildPlugin({ injectRuntime: true })],
    });
    const output = result.outputFiles[0].text;
    expect(output).toMatch(/require\(["']@ts-capture\/core\/preload["']\)/);
    expect(inspected(output)).toTrack("x", { in: entry });
  });

  it("handles entryPoints in {in, out}[] form", async () => {
    const entry = path.join(tmpDir, "inout-entry.ts");
    fs.writeFileSync(entry, `export function f(x) { return x; }`);
    const result = await esbuild.build({
      entryPoints: [{ in: entry, out: "inout-named" }],
      bundle: false,
      write: false,
      platform: "node",
      format: "cjs",
      outdir: tmpDir,
      plugins: [tsCaptureEsbuildPlugin({ injectRuntime: true })],
    });
    const output = result.outputFiles[0].text;
    expect(output).toMatch(/require\(["']@ts-capture\/core\/preload["']\)/);
    expect(inspected(output)).toTrack("x", { in: entry });
  });
});
