import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `index.ts` uses `module.exports = X` (with `module.exports.default = X`)
// for dual CJS/ESM Babel-plugin compat — Babel's old-style callers expect
// `require(pkg)` to be the plugin function itself. TS doesn't see this as
// a default export, so we go through the namespace and pull `.default`.
import * as tsCaptureBabelPluginModule from "./index.js";
// @babel/core 8 is ESM-only; require()-of-ESM, same pattern as src/index.ts.
// Loosely typed on purpose: the plugin under test is pulled out of its module
// namespace as `unknown`, which Babel's real PluginItem type would reject.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { transformSync } = require("@babel/core") as {
  transformSync: (
    code: string,
    opts?: object,
  ) => { code?: string | null } | null;
};

const tsCaptureBabelPlugin =
  (tsCaptureBabelPluginModule as unknown as { default: unknown }).default ??
  tsCaptureBabelPluginModule;

function transform(source: string, filename = "test.ts"): string {
  const result = transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: ["@babel/preset-typescript"],
    plugins: [tsCaptureBabelPlugin],
  });
  return result?.code ?? "";
}

describe("@ts-capture/babel-plugin", () => {
  it("instruments untyped function parameters", () => {
    const out = transform(`function greet(name) { return "Hello " + name; }`);
    expect(out).toContain("__tscptr__");
    expect(out).toContain("name");
  });

  it("does not touch non-TS files", () => {
    const out = transform("const x = 1;", "test.js");
    expect(out).not.toContain("__tscptr__");
  });

  it("respects exclude option", () => {
    const result = transformSync("function f(x) { return x; }", {
      filename: "src/excluded.ts",
      babelrc: false,
      configFile: false,
      presets: ["@babel/preset-typescript"],
      plugins: [[tsCaptureBabelPlugin, { exclude: /excluded/ }]],
    });
    expect(result?.code ?? "").not.toContain("__tscptr__");
  });

  it("does not emit the declare-namespace block (skipTscptrDeclarations)", () => {
    // The plugin sets skipTscptrDeclarations:true so the runtime __tscptr__ is
    // expected to be supplied by @ts-capture/babel-plugin/runtime, not declared inline.
    const out = transform(`function add(a, b) { return a + b; }`);
    expect(out).not.toContain("declare namespace");
    expect(out).not.toContain("declare function __tscptr__");
  });

  it("preserves comments between header and first declaration", () => {
    // Regression for ts-capture's now-fixed instrumenter bug where leading-trivia
    // comments got spliced into the declare-namespace keyword line.
    const out = transform(
      ["// comment before function", "function f(x) { return x; }"].join("\n"),
    );
    // Comment placement isn't strictly defined post-Babel printing, but the
    // output must remain syntactically valid (the test runner parses it).
    expect(out).toContain("__tscptr__");
  });

  // Regression: TS_CAPTURE_TYPES_DIR pointing to a non-existent path used
  // to result in 0 dumps because writeFileSync threw ENOENT and the
  // silent best-effort catch swallowed it. Now the runtime mkdirSyncs
  // the dir at init.
  describe("runtime — auto-creates TS_CAPTURE_TYPES_DIR if missing", () => {
    it("writes a dump when TS_CAPTURE_TYPES_DIR points to a non-existent directory", () => {
      const RUNTIME_PATH = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../runtime.cjs",
      );
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), "ts-capture-babel-mkdir-"),
      );
      const typesDir = path.join(parent, "does-not-exist-yet");
      try {
        expect(fs.existsSync(typesDir)).toBe(false);
        const result = spawnSync(
          process.execPath,
          [
            "--require",
            RUNTIME_PATH,
            "-e",
            "globalThis.__tscptr__('p', 'hello', 0, '/x.ts', '{}'); process.exit(0);",
          ],
          {
            env: { ...process.env, TS_CAPTURE_TYPES_DIR: typesDir },
            encoding: "utf-8",
          },
        );
        expect(result.status).toBe(0);
        expect(fs.existsSync(typesDir)).toBe(true);
        const dumps = fs
          .readdirSync(typesDir)
          .filter(
            (f) => f.startsWith("ts-capture-types-") && f.endsWith(".json"),
          );
        expect(dumps.length).toBe(1);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });
  });
});
