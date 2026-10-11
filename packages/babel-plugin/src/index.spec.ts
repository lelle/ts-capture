import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  inspected,
  type Instrumented,
} from "../../core/src/test-utils/instrumented.js";
import "../../core/src/test-utils/matchers.js";
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

/** Run Babel with the plugin and hold what it printed against the source. */
function transform(
  source: string,
  filename = "test.ts",
  options?: object,
): Instrumented {
  const result = transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: ["@babel/preset-typescript"],
    plugins: [options ? [tsCaptureBabelPlugin, options] : tsCaptureBabelPlugin],
  });
  return inspected(result?.code ?? "", {
    input: source,
    filename,
    additive: true,
  });
}

describe("@ts-capture/babel-plugin", () => {
  it("instruments untyped function parameters", () => {
    const out = transform(`function greet(name) { return "Hello " + name; }`);
    // Babel resolves the file name, so the call records the absolute path.
    expect(out).toTrack("name", { in: path.resolve("test.ts") });
    expect(out).toWrapReturnOf("greet");
  });

  it("does not touch non-TS files", () => {
    const out = transform("const x = 1;", "test.js");
    expect(out).toLeaveUnchanged();
  });

  it("respects exclude option", () => {
    const out = transform("function f(x) { return x; }", "src/excluded.ts", {
      exclude: /excluded/,
    });
    expect(out).toLeaveUnchanged();
  });

  it("does not emit the declare-namespace block (skipTscptrDeclarations)", () => {
    // The plugin sets skipTscptrDeclarations:true so the runtime __tscptr__ is
    // expected to be supplied by @ts-capture/babel-plugin/runtime, not declared inline.
    const out = transform(`function add(a, b) { return a + b; }`);
    expect(out).toTrack("a");
    expect(out).not.toDeclareRuntime();
  });

  it("preserves comments between header and first declaration", () => {
    // Regression for ts-capture's now-fixed instrumenter bug where leading-trivia
    // comments got spliced into the declare-namespace keyword line.
    const out = transform(
      ["// comment before function", "function f(x) { return x; }"].join("\n"),
    );
    // Comment placement isn't strictly defined post-Babel printing, but the
    // output must remain syntactically valid; transform() rejects one that is not.
    expect(out).toTrack("x");
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

  describe("runtime — a process that is killed", () => {
    // A Jest worker ends without the exit handlers running, and a short test
    // file ends before the 500 ms tick and before its tenth observation.
    it("has written the observations made before it died", () => {
      const RUNTIME_PATH = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../runtime.cjs",
      );
      const typesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ts-capture-babel-killed-"),
      );
      try {
        const result = spawnSync(
          process.execPath,
          [
            "--require",
            RUNTIME_PATH,
            "-e",
            [
              "globalThis.__tscptr__('p', 'hello', 0, '/x.ts', '{}');",
              "globalThis.__tscptr__('q', 1, 10, '/x.ts', '{}');",
              "setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);",
            ].join(" "),
          ],
          {
            env: { ...process.env, TS_CAPTURE_TYPES_DIR: typesDir },
            encoding: "utf-8",
          },
        );
        expect(result.signal).toBe("SIGKILL");
        const positions = fs
          .readdirSync(typesDir)
          .flatMap(
            (dump) =>
              JSON.parse(
                fs.readFileSync(path.join(typesDir, dump), "utf-8"),
              ) as [string, number, ...unknown[]][],
          )
          .map(([, position]) => position)
          .sort((a, b) => a - b);
        expect(positions).toEqual([0, 10]);
      } finally {
        fs.rmSync(typesDir, { recursive: true, force: true });
      }
    });
  });

  describe("runtime — one collector per test file", () => {
    it("keeps the observations of every collector started in one process", () => {
      const RUNTIME_PATH = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../runtime.cjs",
      );
      const typesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ts-capture-babel-collectors-"),
      );
      // Jest evaluates setupFiles once per test file, each with a global of
      // its own; loading the runtime against two fresh globals is that.
      const script = [
        `const { createRequire } = require("node:module");`,
        `const source = require("node:fs").readFileSync(${JSON.stringify(RUNTIME_PATH)}, "utf-8");`,
        `const load = () => {`,
        `  const sandbox = {};`,
        `  new Function("require", "globalThis", source)(createRequire(${JSON.stringify(RUNTIME_PATH)}), sandbox);`,
        `  return sandbox.__tscptr__;`,
        `};`,
        `const first = load();`,
        `const second = load();`,
        `first("p", "hello", 0, "/first.ts", "{}");`,
        `second("q", 1, 0, "/second.ts", "{}");`,
        `process.exit(0);`,
      ].join("\n");
      try {
        const result = spawnSync(process.execPath, ["-e", script], {
          env: { ...process.env, TS_CAPTURE_TYPES_DIR: typesDir },
          encoding: "utf-8",
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const observedFiles = fs
          .readdirSync(typesDir)
          .flatMap(
            (dump) =>
              JSON.parse(
                fs.readFileSync(path.join(typesDir, dump), "utf-8"),
              ) as [string, ...unknown[]][],
          )
          .map(([filename]) => filename)
          .sort();
        expect(observedFiles).toEqual(["/first.ts", "/second.ts"]);
      } finally {
        fs.rmSync(typesDir, { recursive: true, force: true });
      }
    });
  });

  describe("runtime — flush", () => {
    it("rewrites the dump when a known position gains a new type", () => {
      const RUNTIME_PATH = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../runtime.cjs",
      );
      const typesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ts-capture-babel-flush-"),
      );
      try {
        const result = spawnSync(
          process.execPath,
          [
            "--require",
            RUNTIME_PATH,
            "-e",
            [
              "globalThis.__tscptr__('p', null, 0, '/x.ts', '{}');",
              "process.emit('beforeExit', 0);",
              "globalThis.__tscptr__('p', undefined, 0, '/x.ts', '{}');",
              "process.exit(0);",
            ].join(" "),
          ],
          {
            env: { ...process.env, TS_CAPTURE_TYPES_DIR: typesDir },
            encoding: "utf-8",
          },
        );
        expect(result.status).toBe(0);
        const [dumpFile] = fs.readdirSync(typesDir);
        const dump = JSON.parse(
          fs.readFileSync(path.join(typesDir, dumpFile), "utf-8"),
        ) as [string, number, [string, unknown][], unknown][];
        expect(dump).toHaveLength(1);
        expect(dump[0][2].map(([typeName]) => typeName).sort()).toEqual([
          "null",
          "undefined",
        ]);
      } finally {
        fs.rmSync(typesDir, { recursive: true, force: true });
      }
    });
  });
});
