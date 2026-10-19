import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type Applied, checked, parseErrors } from "./test-utils/applied.js";

const CLI = path.resolve("dist/cli.js");

function run(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 10000,
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", exitCode: err.status ?? 1 };
  }
}

function runCapturingStderr(...args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const child = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    timeout: 10000,
  });
  return {
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    exitCode: child.status ?? 1,
  };
}

function runInDir(
  cwd: string,
  ...args: string[]
): { stdout: string; stderr: string; exitCode: number } {
  const child = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    cwd,
  });
  return {
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    exitCode: child.status ?? 1,
  };
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-cli-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    noImplicitAny: false,
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "Bundler",
    skipLibCheck: true,
    noEmit: true,
  },
  include: ["**/*.ts"],
});

const FOO = "function foo(a) { return a; }";

/** A file as the CLI left it, held against what it was given. */
function fileAfter(file: string, before: string): Applied {
  return checked(before, fs.readFileSync(file, "utf-8"), { filename: path.basename(file) });
}

describe("cli", () => {
  describe("no args / help", () => {
    it("prints usage when called with no args", () => {
      const { stdout, exitCode } = run();
      expect(stdout).toContain("ts-capture");
      expect(stdout).toContain("instrument");
      expect(stdout).toContain("apply");
      expect(stdout).toContain("coverage");
      expect(exitCode).toBe(0);
    });

    it("prints help with --help", () => {
      const { stdout } = run("--help");
      expect(stdout).toContain("ts-capture");
    });

    it("names every flag apply accepts", () => {
      const { stdout } = run("--help");
      for (const flag of [
        "--dry-run",
        "--comments",
        "--both",
        "--include-tests",
        "--force",
        "--telemetry",
        "--report",
        "--project",
      ]) {
        expect(stdout).toContain(flag);
      }
    });
  });

  describe("verify", () => {
    it("locates each mismatch as file:line:col and counts the unverifiable by reason", () => {
      withTmpDir((rawDir) => {
        const dir = fs.realpathSync(rawDir);
        const source =
          "export function add(a: string, b: any, c: Set<string>, d: number) {\n  return a;\n}\n";
        const file = path.join(dir, "a.ts");
        fs.writeFileSync(file, source);
        fs.writeFileSync(
          path.join(dir, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { strict: true }, include: ["a.ts"] }),
        );
        const posAfter = (name: string) => source.indexOf(name) + name.length;
        const typeInfo = [
          [file, posAfter("(a"), [["number", undefined]], {}],
          [file, posAfter(" b"), [["number", undefined]], {}],
          [file, posAfter(" c"), [["Map<string, number>", undefined]], {}],
          [file, posAfter(" d"), [["number", undefined]], {}],
        ];
        const typesPath = path.join(dir, "types.json");
        fs.writeFileSync(typesPath, JSON.stringify(typeInfo));

        const { stdout, exitCode } = runInDir(
          dir,
          "verify",
          "types.json",
          "--project",
          "tsconfig.json",
        );

        expect(exitCode).toBe(0);
        expect(stdout).not.toContain("pos ");
        expect(stdout).toContain("a.ts:1:21  a");
        expect(stdout).toContain("declared  string");
        expect(stdout).toContain("observed  number");
        // A Map where a Set is written: the checker settles what the text could not.
        expect(stdout).toContain("1 match, 2 mismatch, 1 unverifiable");
        expect(stdout).toContain("1 declared any");
      });
    });

    describe("observations of written types", () => {
      const source =
        "export function add(a: string) {\n  return a;\n}\nexport let n = 1;\nexport let s = 'x';\n";
      const posAfter = (needle: string) => source.indexOf(needle) + needle.length;
      // `a` has a written type; `n` and `s` are inferred.
      const observe = (aOpts: object) => (file: string) => [
        [file, posAfter("(a"), [["number", undefined]], aOpts],
        [file, posAfter("let n"), [["number", undefined]], { varDecl: true }],
        [file, posAfter("let s"), [["number", undefined]], { varDecl: true }],
      ];
      const verifyWith = (typeInfo: (file: string) => unknown[], ...flags: string[]) =>
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          const file = path.join(dir, "a.ts");
          fs.writeFileSync(file, source);
          fs.writeFileSync(
            path.join(dir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { strict: true }, include: ["a.ts"] }),
          );
          fs.writeFileSync(path.join(dir, "types.json"), JSON.stringify(typeInfo(file)));
          return runInDir(dir, "verify", "types.json", "--project", "tsconfig.json", ...flags);
        });

      it("warns when there are none, so a missing flag does not read as all types right", () => {
        const { stderr, exitCode } = verifyWith(observe({}));
        expect(exitCode).toBe(0);
        expect(stderr).toContain("TS_CAPTURE_OBSERVE_ANNOTATED=1");
      });

      it("does not warn when there are", () => {
        const { stderr } = verifyWith(observe({ annotated: true }));
        expect(stderr).not.toContain("TS_CAPTURE_OBSERVE_ANNOTATED");
      });

      it("reports written types first, each section with its own mismatches and count", () => {
        const { stdout } = verifyWith(observe({ annotated: true }));
        const order = [
          "Written types (1 checked)",
          "a.ts:1:21  a",
          "0 match, 1 mismatch, 0 unverifiable",
          "Inferred types (2 checked)",
          "a.ts:5:12  s",
          "1 match, 1 mismatch, 0 unverifiable",
        ].map((text) => stdout.indexOf(text));
        expect(order).not.toContain(-1);
        expect(order).toEqual([...order].sort((x, y) => x - y));
      });

      it("keeps one report when no written types were observed", () => {
        const { stdout } = verifyWith(observe({}));
        expect(stdout).not.toContain("Written types");
        expect(stdout).toContain("3 observed positions: 1 match, 2 mismatch");
      });

      it("holds --threshold to the written types when there are any", () => {
        // 1 of 3 match overall, which passes 0.3; 0 of 1 written types do not.
        const { stderr, exitCode } = verifyWith(observe({ annotated: true }), "--threshold=0.3");
        expect(exitCode).toBe(2);
        expect(stderr).toContain("written types");
      });

      it("holds --threshold to every position when there are no written types", () => {
        const { exitCode } = verifyWith(observe({}), "--threshold=0.3");
        expect(exitCode).toBe(0);
      });
    });
  });

  describe("instrument", () => {
    it("instruments a file and writes to stdout", () => {
      withTmpDir((dir) => {
        const srcFile = path.join(dir, "test.ts");
        fs.writeFileSync(srcFile, FOO);
        const { stdout, exitCode } = run("instrument", srcFile);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("__tscptr__");
      });
    });

    it("instruments in-place with --in-place", () => {
      withTmpDir((dir) => {
        const srcFile = path.join(dir, "test.ts");
        fs.writeFileSync(srcFile, FOO);
        const { exitCode } = run("instrument", "--in-place", srcFile);
        expect(exitCode).toBe(0);
        const result = fs.readFileSync(srcFile, "utf-8");
        expect(result).toContain("__tscptr__");
      });
    });

    it("exits with 1 when file not found", () => {
      const { exitCode } = run("instrument", "/nonexistent/file.ts");
      expect(exitCode).toBe(1);
    });
  });

  describe("apply", () => {
    it("applies types from a JSON file", () => {
      withTmpDir((dir) => {
        const srcFile = path.join(dir, "test.ts");
        fs.writeFileSync(srcFile, FOO);

        // Collected type info: [filename, offset, [[typeName, sourcePos]], opts]
        const typeInfo = [[srcFile, 14, [["string", undefined]], {}]];
        const jsonFile = path.join(dir, "types.json");
        fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

        const { exitCode } = run("apply", jsonFile);
        expect(exitCode).toBe(0);

        const out = fileAfter(srcFile, FOO);
        expect(out).toAnnotate("a", "string");
        expect(out).toHaveNoNewDiagnostics();
      });
    });

    it("exits with 1 when JSON file not found", () => {
      const { exitCode } = run("apply", "/nonexistent/types.json");
      expect(exitCode).toBe(1);
    });

    // Preprocessor adapters (e.g. @ts-capture/svelte) emit observations
    // keyed by synthetic paths — virtual TS modules derived from a block
    // inside a host file (`<file>.svelte__script.ts`, and by the same
    // convention a future `<file>.vue__script.ts`). These paths do not
    // exist on disk. When no plugin claims them, the core apply step must
    // skip them gracefully — keyed on on-disk absence, not on any one
    // framework's naming — rather than crash on the first missing-file
    // open.
    describe("synthetic virtual paths not present on disk", () => {
      it("skips *.svelte__script.ts entries with a warning instead of crashing", () => {
        withTmpDir((dir) => {
          // A real .ts file that SHOULD be applied normally.
          const realFile = path.join(dir, "real.ts");
          fs.writeFileSync(realFile, FOO);

          // A synthetic svelte virtual path that does NOT exist on disk.
          // Before the fix, apply would throw ENOENT here and the whole
          // run would crash before touching any .ts files.
          const syntheticFile = path.join(dir, "Component.svelte__script.ts");

          const typeInfo = [
            [syntheticFile, 14, [["number", undefined]], {}],
            [realFile, 14, [["string", undefined]], {}],
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stderr } = runCapturingStderr("apply", jsonFile);
          expect(exitCode).toBe(0);
          // Warning names the offending path and an actionable example
          // (the svelte plugin) so the user can wire up an applier.
          expect(stderr).toMatch(/svelte/i);
          expect(stderr).toContain("Component.svelte__script.ts");
          // The real .ts file is applied normally — synthetic entries
          // skipping does not block the rest.
          expect(fileAfter(realFile, FOO)).toAnnotate("a", "string");
        });
      });

      it("skips *.svelte__module.ts entries the same way", () => {
        withTmpDir((dir) => {
          const syntheticFile = path.join(dir, "Component.svelte__module.ts");
          const typeInfo = [[syntheticFile, 14, [["number", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stderr } = runCapturingStderr("apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(stderr).toContain("Component.svelte__module.ts");
        });
      });

      it("skips a non-svelte unclaimed virtual path that isn't on disk", () => {
        // The skip decision is framework-agnostic: any path that no
        // plugin claims AND does not exist on disk is skipped. A
        // `.vue__script.ts` synthetic path (no svelte naming) must be
        // handled identically — before the fix it slipped past the
        // svelte-specific regex and crashed on the missing-file read.
        withTmpDir((dir) => {
          const realFile = path.join(dir, "real.ts");
          fs.writeFileSync(realFile, FOO);
          const syntheticFile = path.join(dir, "Widget.vue__script.ts");

          const typeInfo = [
            [syntheticFile, 14, [["number", undefined]], {}],
            [realFile, 14, [["string", undefined]], {}],
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stderr } = runCapturingStderr("apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(stderr).toContain("Widget.vue__script.ts");
          // The real file still applies — one orphaned virtual path
          // does not abort the run.
          expect(fileAfter(realFile, FOO)).toAnnotate("a", "string");
        });
      });

      it("ts-capture.config.mjs plugin handles synthetic paths instead of safety-net", () => {
        // With a plugin registered for synthetic paths, the CLI
        // routes them to the plugin instead of printing the
        // safety-net warning. End-to-end smoke: a tiny plugin
        // matches `*.virtual.fake`, resolves to `target.ts`, and
        // appends a marker to the source. The CLI's apply loop
        // should load the plugin from ts-capture.config.mjs, call
        // its apply, and write the marker through to disk.
        withTmpDir((dir) => {
          // Real file the plugin routes to.
          const targetFile = path.join(dir, "target.ts");
          fs.writeFileSync(targetFile, "// before\n");

          // Synthetic virtual path — does NOT exist on disk. Pairs
          // with `target.ts` via the plugin's resolveSourceFile below.
          const syntheticFile = path.join(dir, "target.virtual.fake");

          // Minimal ts-capture.config.mjs that defines the plugin
          // inline. No imports — keeps the test hermetic against
          // workspace install state.
          const configPath = path.join(dir, "ts-capture.config.mjs");
          fs.writeFileSync(
            configPath,
            [
              "export default {",
              "  plugins: [",
              "    {",
              "      name: 'fake-plugin',",
              `      match: (f) => f.endsWith('.virtual.fake'),`,
              `      resolveSourceFile: (f) => f.replace(/\\.virtual\\.fake$/, '.ts'),`,
              `      apply: (source, entries, _opts) =>`,
              `        source + '// plugin-applied: ' + entries.length + ' entries\\n',`,
              "    },",
              "  ],",
              "};",
              "",
            ].join("\n"),
          );

          const typeInfo = [
            [syntheticFile, 0, [["string", undefined]], {}],
            [syntheticFile, 5, [["number", undefined]], {}],
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stderr } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          // Safety-net warning must NOT fire — the plugin claimed the file.
          expect(stderr).not.toMatch(/Skipping.*virtual/i);
          // The plugin's apply ran and appended its marker.
          const after = fs.readFileSync(targetFile, "utf-8");
          expect(after).toContain("// before");
          expect(after).toContain("plugin-applied: 2 entries");
        });
      });

      it("counts and reports what a plugin returning an AnnotateResult wrote and skipped", () => {
        withTmpDir((dir) => {
          const targetFile = path.join(dir, "target.ts");
          fs.writeFileSync(targetFile, "let a;\nlet b;\n");
          const syntheticFile = path.join(dir, "target.virtual.fake");
          fs.writeFileSync(
            path.join(dir, "ts-capture.config.mjs"),
            [
              "export default {",
              "  plugins: [",
              "    {",
              "      name: 'fake-plugin',",
              `      match: (f) => f.endsWith('.virtual.fake'),`,
              `      resolveSourceFile: (f) => f.replace(/\\.virtual\\.fake$/, '.ts'),`,
              `      apply: (source) => ({`,
              `        text: source.replace('let a;', 'let a: number;'),`,
              `        skips: [{ pos: 12, reason: 'no-information', observed: 'unknown' }],`,
              `        telemetry: { totalEntries: 2, emitted: 1, idempotent: 0, unparseable: 0,`,
              `          positionMismatch: 0, verifyReject: 0, redundant: 0, skipped: [] },`,
              `      }),`,
              "    },",
              "  ],",
              "};",
              "",
            ].join("\n"),
          );
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(
            jsonFile,
            JSON.stringify([
              [syntheticFile, 5, [["number", undefined]], { varDecl: true }],
              [syntheticFile, 12, [["unknown", undefined]], { varDecl: true }],
            ]),
          );

          const { stdout } = runInDir(dir, "apply", jsonFile, "--report");
          expect(stdout).toContain("apply: 1 annotation written in 1 file.\n");
          expect(stdout).toMatch(
            / {2}Carries no type information \(1\)\n {4}\S*target\.ts:2:5 {2}b\n/,
          );
          expect(fs.readFileSync(targetFile, "utf-8")).toBe("let a: number;\nlet b;\n");
        });
      });

      it("invalid plugin config produces a clear error, not a silent skip", () => {
        withTmpDir((dir) => {
          const configPath = path.join(dir, "ts-capture.config.mjs");
          fs.writeFileSync(
            configPath,
            // Missing the required `apply` function — should fail validation.
            "export default { plugins: [{ name: 'broken' }] };\n",
          );
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, "[]");
          const { exitCode, stderr } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(1);
          expect(stderr).toMatch(/invalid plugin/i);
        });
      });

      // Regression: the verify gate builds one LanguageService for the run,
      // but nothing told it what earlier files had been written. Every file
      // was checked against a project where all previously-applied files were
      // still unannotated, so annotations that only conflict in combination
      // reached disk. Surfaced on nestjs/nest, where six type errors survived
      // a run with `typecheckVerify` on.
      // A solution-style tsconfig — `files: []` plus `references` — is the
      // standard shape for a TypeScript monorepo, and upward discovery finds
      // it. It yields a Program with nothing in it, so every checker-backed
      // rule turns off at once: on honojs/hono that took the same
      // observations from 88 annotations to 1078 and broke a build that
      // compiled before. Nothing said so; the only trace was two telemetry
      // counters reading zero.
      it("says so when the discovered tsconfig holds no files", () => {
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          fs.writeFileSync(
            path.join(dir, "tsconfig.json"),
            JSON.stringify({ files: [], references: [{ path: "./tsconfig.src.json" }] }),
          );
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, "export function foo(a) { return a; }\n");
          fs.writeFileSync(
            path.join(dir, "types.json"),
            JSON.stringify([[file, 20, [["number", null]], {}]]),
          );

          const { stderr } = runInDir(dir, "apply", "types.json");
          expect(stderr).toMatch(/no files/i);
          expect(stderr).toContain("--project");
        });
      });

      // The escape hatch the warning names. Upward discovery cannot choose
      // among a solution config's references — they carry different
      // compilerOptions, and merging them would answer about a project nobody
      // asked for — so the caller names the one that covers these files.
      it("--project points apply at a tsconfig discovery cannot choose", () => {
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          const options = {
            noImplicitAny: false,
            target: "ES2022",
            module: "ES2022",
            moduleResolution: "Bundler",
            skipLibCheck: true,
            noEmit: true,
          };
          fs.writeFileSync(
            path.join(dir, "tsconfig.json"),
            JSON.stringify({ files: [], references: [{ path: "./tsconfig.src.json" }] }),
          );
          fs.writeFileSync(
            path.join(dir, "tsconfig.src.json"),
            JSON.stringify({ compilerOptions: options, include: ["**/*.ts"] }),
          );
          const file = path.join(dir, "lib.ts");
          // `g()` returns a string and the checker knows it, so a redundant
          // annotation here is dropped only when a Program is actually in hand.
          fs.writeFileSync(
            file,
            'function g(): string {\n  return "x";\n}\nexport const v = g();\n',
          );
          const src = fs.readFileSync(file, "utf-8");
          fs.writeFileSync(
            path.join(dir, "types.json"),
            JSON.stringify([
              [file, src.indexOf("const v") + 7, [["string", null]], { varDecl: true }],
            ]),
          );

          const { stderr } = runInDir(dir, "apply", "types.json", "--project", "tsconfig.src.json");
          expect(stderr).not.toMatch(/no files/i);
          expect(fileAfter(file, src)).toLeaveUntyped("v");
        });
      });

      it("judges a local against a callee typed in another file, whichever comes first", () => {
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
          const pricing = path.join(dir, "pricing.ts");
          const pricingSource = "export function price(a) {\n  return a;\n}\n";
          fs.writeFileSync(pricing, pricingSource);
          const orders = path.join(dir, "orders.ts");
          const ordersSource = 'import { price } from "./pricing";\nexport const p = price(3);\n';
          fs.writeFileSync(orders, ordersSource);
          // The importer comes first in types.json; the run must still see
          // `price` typed before it judges `p`.
          const typeInfo = [
            [orders, ordersSource.indexOf("const p") + 7, [["number", null]], { varDecl: true }],
            [pricing, pricingSource.indexOf("(a)") + 2, [["number", null]], {}],
            [pricing, pricingSource.indexOf("(a)") + 3, [["number", null]], { returnType: true }],
          ];
          fs.writeFileSync(path.join(dir, "types.json"), JSON.stringify(typeInfo));

          runInDir(dir, "apply", "types.json");

          const priced = fileAfter(pricing, pricingSource);
          expect(priced).toAnnotate("a", "number");
          expect(priced).toAnnotate({ returnOf: "price" }, "number");
          expect(fs.readFileSync(orders, "utf-8")).toBe(ordersSource);
        });
      });

      it("verify sees annotations already applied to earlier files", () => {
        withTmpDir((rawDir) => {
          // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var).
          // The CLI resolves the project through process.cwd(), so unresolved
          // paths in types.json never match `userFiles` and the verify gate
          // silently switches off — the test would pass for the wrong reason.
          const dir = fs.realpathSync(rawDir);
          fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
          const aFile = path.join(dir, "a.ts");
          const bFile = path.join(dir, "b.ts");
          const aSource = "export function makeValue(x) {\n  return x;\n}\n";
          const bSource =
            'import { makeValue } from "./a.js";\n' +
            "export function useValue(v) {\n  return makeValue(v);\n}\n";
          fs.writeFileSync(aFile, aSource);
          fs.writeFileSync(bFile, bSource);

          // Once `a.ts` gets `x: string`, annotating `v` as `string | number`
          // makes `makeValue(v)` a type error — but only a verify pass that
          // knows about `a.ts`'s new annotation can see that.
          const typeInfo = [
            [aFile, aSource.indexOf("x)") + 1, [["string", undefined]], {}],
            [
              bFile,
              bSource.indexOf("v)") + 1,
              [
                ["string", undefined],
                ["number", undefined],
              ],
              {},
            ],
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fileAfter(aFile, aSource)).toAnnotate("x", "string");
          // The union annotation on `v` must be rejected: with `x: string`
          // already on disk, `makeValue(v)` would not type-check.
          expect(fileAfter(bFile, bSource)).toLeaveUntyped("v");
        });
      });

      // `--dry-run` answers "what would this run write?", so it has to advance
      // the in-memory source the same way. Nothing here touches disk; a
      // preview that judged every file against the project's starting state
      // listed files the real run then rejects at verify.
      it("dry-run previews the same files the real run would write", () => {
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
          const aFile = path.join(dir, "a.ts");
          const bFile = path.join(dir, "b.ts");
          const aSource = "export function makeValue(x) {\n  return x;\n}\n";
          const bSource =
            'import { makeValue } from "./a.js";\n' +
            "export function useValue(v) {\n  return makeValue(v);\n}\n";
          fs.writeFileSync(aFile, aSource);
          fs.writeFileSync(bFile, bSource);

          const typeInfo = [
            [aFile, aSource.indexOf("x)") + 1, [["string", undefined]], {}],
            [
              bFile,
              bSource.indexOf("v)") + 1,
              [
                ["string", undefined],
                ["number", undefined],
              ],
              {},
            ],
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stdout } = runInDir(dir, "apply", jsonFile, "--dry-run");
          expect(exitCode).toBe(0);
          // `b.ts` is the file the real run rejects at verify, so the preview
          // must not offer it.
          expect(stdout).toContain("a.ts");
          expect(stdout).not.toContain("b.ts");
          // And a dry run writes nothing.
          expect(fs.readFileSync(aFile, "utf-8")).toBe(aSource);
          expect(fs.readFileSync(bFile, "utf-8")).toBe(bSource);
        });
      });

      it("does not skip a normal .ts file even when path contains 'svelte'", () => {
        // `svelte-utils.ts` is a normal file that happens to mention
        // svelte — it must still be applied normally.
        withTmpDir((dir) => {
          const file = path.join(dir, "svelte-utils.ts");
          fs.writeFileSync(file, FOO);

          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fileAfter(file, FOO)).toAnnotate("a", "string");
        });
      });
    });

    // Test/spec files get unwanted annotations (e.g.
    // `it("...", (): Assertion => ...)`) when apply runs on a vitest
    // project. Default-exclude common test glob patterns; honor an
    // opt-back-in flag for users who really want to apply to specs.
    // Driven through the real CLI, not the applier directly: the CLI routes
    // entries through two appliers and a pass-through path, and a unit test on
    // one applier passed today while the path the CLI actually takes was
    // broken. These fixtures are the only form that would have caught it.
    describe("does not write annotations weaker than the code already has", () => {
      function applyFixture(
        source: string,
        entries: (dir: string, src: string) => unknown[],
      ): Applied {
        let out: Applied | undefined;
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
          const file = path.join(dir, "a.ts");
          fs.writeFileSync(file, source);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(entries(file, source)));
          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          out = fileAfter(file, source);
        });
        return out!;
      }

      // Fixtures deliberately use a pass-through parameter, so the vacuous
      // annotation is *valid* TypeScript. An earlier version of these tests
      // annotated a called parameter, which the verify gate rejected as a type
      // error — they passed without any vacuity rule existing.
      const PASSTHROUGH = "export function run(x) {\n  return x;\n}\n";

      // `unknown` inside a generic was the single largest group in the nest
      // diff: 25 `Promise<unknown>`, 7 `Map<unknown, unknown>`, 6 `Set<unknown>`.
      // Knowing a value is a Promise without knowing what it resolves to is not
      // worth rewriting a line for.
      it("skips a type carrying `unknown` inside a generic", () => {
        const result = applyFixture(PASSTHROUGH, (file, src) => [
          [file, src.indexOf("(x)") + 2, [["Promise<unknown>", null]], {}],
        ]);
        expect(result.text).toBe(PASSTHROUGH);
      });

      it("skips a bare `unknown`", () => {
        const result = applyFixture(PASSTHROUGH, (file, src) => [
          [file, src.indexOf("(x)") + 2, [["unknown", null]], {}],
        ]);
        expect(result.text).toBe(PASSTHROUGH);
      });

      it("skips a function type whose parameters are all `unknown`", () => {
        const result = applyFixture(PASSTHROUGH, (file, src) => [
          [file, src.indexOf("(x)") + 2, [["(a: unknown) => unknown", null]], {}],
        ]);
        expect(result.text).toBe(PASSTHROUGH);
      });

      it("still writes a type that describes the value", () => {
        const result = applyFixture(PASSTHROUGH, (file, src) => [
          [file, src.indexOf("(x)") + 2, [["string", null]], {}],
        ]);
        expect(result).toAnnotate("x", "string");
      });
    });

    // 23 `: void` annotations survived the checker oracle in the nest run.
    // Return-type sites do cover arrow functions and methods, so the oracle
    // should have recognised them as identical to TypeScript's own inference.
    describe("does not restate a return type the checker already infers", () => {
      function applyReturnFixture(
        source: string,
        pos: (src: string) => number,
        extraArgs: string[] = [],
      ): Applied {
        let out: Applied | undefined;
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
          const file = path.join(dir, "a.ts");
          fs.writeFileSync(file, source);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(
            jsonFile,
            JSON.stringify([[file, pos(source), [["void", null]], { returnType: true }]]),
          );
          const { exitCode } = runInDir(dir, "apply", jsonFile, ...extraArgs);
          expect(exitCode).toBe(0);
          out = fileAfter(file, source);
        });
        return out!;
      }

      it("skips `: void` on a function declaration", () => {
        const source = "export function run(cb) {\n  cb();\n}\n";
        expect(applyReturnFixture(source, (s) => s.indexOf("(cb)") + 4)).toLeaveUntyped({
          returnOf: "run",
        });
      });

      it("skips `: void` on a class method", () => {
        const source = "export class A {\n  run(cb) {\n    cb();\n  }\n}\n";
        expect(applyReturnFixture(source, (s) => s.indexOf("(cb)") + 4)).toLeaveUntyped({
          returnOf: "run",
        });
      });

      // The nest case: `public get(...args: any[])` is the *implementation* of
      // an overloaded method, and the observation is `undefined` rather than
      // `void`.
      it("skips `: void` on an overload implementation", () => {
        const source =
          "export class A {\n" +
          "  run(cb: () => void): void;\n" +
          "  run(p: string, cb: () => void): void;\n" +
          "  run(...args: any[]) {\n    args;\n  }\n" +
          "}\n";
        // The overload signatures are typed `run`s too, so the file is the claim.
        expect(applyReturnFixture(source, (s) => s.indexOf("(...args: any[])") + 16).text).toBe(
          source,
        );
      });

      it("skips `: void` on an arrow function", () => {
        const source = "export const run = (cb) => {\n  cb();\n};\n";
        expect(applyReturnFixture(source, (s) => s.indexOf("(cb)") + 4)).toLeaveUntyped({
          returnOf: "run",
        });
      });
    });

    describe("a file the tsconfig does not list", () => {
      it("checks each annotation against the project before writing it", () => {
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          fs.writeFileSync(
            path.join(dir, "tsconfig.json"),
            JSON.stringify({ ...JSON.parse(TSCONFIG), include: undefined, files: ["lib.ts"] }),
          );
          fs.writeFileSync(path.join(dir, "lib.ts"), "export const unit = 2;\n");
          const source =
            'import { unit } from "./lib";\n' +
            "export function scale(n) { return n * unit; }\n" +
            "export function shout(s) { return s.toUpperCase(); }\n";
          const file = path.join(dir, "outside.ts");
          fs.writeFileSync(file, source);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(
            jsonFile,
            JSON.stringify([
              [file, source.indexOf("n)") + 1, [["number", undefined]], {}],
              [file, source.indexOf("s)") + 1, [["number", undefined]], {}],
            ]),
          );
          const { stdout } = runInDir(dir, "apply", jsonFile, "--report");
          expect(fileAfter(file, source)).toAnnotate("n", "number");
          expect(fileAfter(file, source)).toLeaveUntyped("s");
          expect(stdout).toContain("Would add a type error");
        });
      });
    });

    // `apply` rewrites source files, and the flags that stop it from doing so
    // are exactly the ones a typo turns off. Unknown flags still pass — a
    // script sending a flag a newer version understands must keep working —
    // but they no longer pass in silence.
    describe("report of what was written and what was not", () => {
      function project(
        files: Record<string, string>,
        entries: (at: (file: string, marker: string) => [string, number]) => unknown[],
        fn: (dir: string, jsonFile: string) => void,
      ): void {
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
          for (const [name, source] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, name), source);
          }
          // The position just after `marker`'s first character run: `x)` → after `x`.
          const at = (file: string, marker: string): [string, number] => [
            path.join(dir, file),
            files[file].indexOf(marker) + marker.length - 1,
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(entries(at)));
          fn(dir, jsonFile);
        });
      }

      const GREET = 'export function greet(name) {\n  return "Hi " + name;\n}\n';

      it("says how much was written", () => {
        project(
          { "greet.ts": GREET },
          (at) => [[...at("greet.ts", "name)"), [["string", undefined]], {}]],
          (dir, jsonFile) => {
            const { stdout } = runInDir(dir, "apply", jsonFile);
            expect(stdout).toBe("apply: 1 annotation written in 1 file.\n");
          },
        );
      });

      // The annotation is right, but `use.ts` adds a property the type would
      // then not have. Apply refuses it; before this the refusal was silent.
      const CART = "export function addLine(cart) {\n  return cart;\n}\n";
      const USE =
        'import { addLine } from "./cart.js";\n' +
        "const cart = addLine({ lines: [1] });\n" +
        "cart.coupon = 1;\n";
      const cartEntries = (at: (file: string, marker: string) => [string, number]) => [
        [...at("cart.ts", "cart)"), [["{ lines: number[] }", undefined]], {}],
      ];

      it("counts an observed position it did not write, and points at --report", () => {
        project({ "cart.ts": CART, "use.ts": USE }, cartEntries, (dir, jsonFile) => {
          const { stdout } = runInDir(dir, "apply", jsonFile);
          expect(stdout).toBe(
            "apply: 0 annotations written in 0 files.\n" +
              "       1 observed position not written (1 would add a type error) - see --report.\n",
          );
        });
      });

      it("--report names the position, the observed type and the error it would add", () => {
        project({ "cart.ts": CART, "use.ts": USE }, cartEntries, (dir, jsonFile) => {
          const { stdout } = runInDir(dir, "apply", jsonFile, "--report");
          expect(stdout).toContain("Observed but not written (1)");
          expect(stdout).toContain("  Would add a type error (1)\n");
          expect(stdout).toContain("    cart.ts:1:25  cart\n");
          expect(stdout).toContain("      observed  { lines: number[] }\n");
          expect(stdout).toContain("      TS2339 at use.ts:3: Property 'coupon' does not exist");
          expect(stdout).not.toContain("see --report");
        });
      });

      it("--report separates an observation that says nothing from one naming an unreachable type", () => {
        project(
          {
            "a.ts": "export function run(task, widget) {\n  return [task, widget];\n}\n",
          },
          (at) => [
            [...at("a.ts", "task,"), [["unknown", undefined]], {}],
            [...at("a.ts", "widget)"), [["Widget", undefined]], {}],
          ],
          (dir, jsonFile) => {
            const { stdout } = runInDir(dir, "apply", jsonFile, "--report");
            expect(stdout).toContain("  Carries no type information (1)\n    a.ts:1:21  task\n");
            expect(stdout).toContain(
              "  Refers to a type this file cannot name (1)\n    a.ts:1:27  widget\n" +
                "      observed  Widget\n" +
                "      Widget is not in scope\n",
            );
          },
        );
      });

      it("--report counts, without listing, what TypeScript already had", () => {
        project(
          { "greet.ts": 'export function greet(name: string) {\n  return "Hi " + name;\n}\n' },
          // `at` stops one short of the marker's end: just past the `)`.
          (at) => [[...at("greet.ts", "string) "), [["string", undefined]], { returnType: true }]],
          (dir, jsonFile) => {
            const { stdout } = runInDir(dir, "apply", jsonFile, "--report");
            expect(stdout).toContain("Nothing to add (1)\n  1 already inferred by TypeScript\n");
            expect(stdout).not.toContain("Observed but not written");
          },
        );
      });

      it("--dry-run gives the same count as the run it previews", () => {
        project({ "cart.ts": CART, "use.ts": USE }, cartEntries, (dir, jsonFile) => {
          const { stdout } = runInDir(dir, "apply", jsonFile, "--dry-run");
          expect(stdout).toContain(
            "1 observed position not written (1 would add a type error) - see --report.",
          );
        });
      });
    });

    describe("unrecognised flags", () => {
      it("warns instead of silently applying when a safety flag is misspelled", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "a.ts");
          fs.writeFileSync(file, FOO);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify([[file, 14, [["string", undefined]], {}]]));
          const { exitCode, stderr } = runInDir(dir, "apply", jsonFile, "--comment");
          expect(exitCode).toBe(0);
          expect(stderr).toContain("--comment");
          expect(stderr).toContain("--comments");
        });
      });

      it("says nothing about the flags it knows", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "a.ts");
          fs.writeFileSync(file, FOO);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify([[file, 14, [["string", undefined]], {}]]));
          const { stderr } = runInDir(dir, "apply", jsonFile, "--dry-run", "--comments");
          expect(stderr).not.toContain("unrecognised");
        });
      });
    });

    // The setting chose the offset-based applier, which is gone.
    describe("infer.cstAware=false", () => {
      it("says it no longer has an effect, and applies as without it", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "a.ts");
          fs.writeFileSync(file, FOO);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify([[file, 14, [["string", undefined]], {}]]));
          const { exitCode, stderr } = runInDir(dir, "apply", jsonFile, "--infer.cstAware=false");
          expect(exitCode).toBe(0);
          expect(stderr).toContain("infer.cstAware has no effect");
          expect(fileAfter(file, FOO)).toAnnotate("a", "string");
        });
      });
    });

    describe("default test-file exclusion", () => {
      it("skips *.spec.ts files by default", () => {
        withTmpDir((dir) => {
          const specFile = path.join(dir, "math.spec.ts");
          fs.writeFileSync(specFile, FOO);

          const typeInfo = [[specFile, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          // File should be unchanged
          expect(fs.readFileSync(specFile, "utf-8")).toBe(FOO);
        });
      });

      it("skips *.test.tsx files by default", () => {
        withTmpDir((dir) => {
          const specFile = path.join(dir, "Component.test.tsx");
          const original = "function Foo(a) { return a; }";
          fs.writeFileSync(specFile, original);

          const typeInfo = [[specFile, 13, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(specFile, "utf-8")).toBe(original);
        });
      });

      it("does not skip non-test files even if filename contains 'spec' or 'test'", () => {
        withTmpDir((dir) => {
          // `inspector.ts` contains "spect" but isn't a spec file
          const file = path.join(dir, "inspector.ts");
          fs.writeFileSync(file, FOO);

          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fileAfter(file, FOO)).toAnnotate("a", "string");
        });
      });

      it("--include-tests opts back in", () => {
        withTmpDir((dir) => {
          const specFile = path.join(dir, "math.spec.ts");
          fs.writeFileSync(specFile, FOO);

          const typeInfo = [[specFile, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile, "--include-tests");
          expect(exitCode).toBe(0);
          expect(fileAfter(specFile, FOO)).toAnnotate("a", "string");
        });
      });
    });

    // The built-in test-file skip is just the default first entry of a
    // gitignore-style chain. `apply.skipFiles` in ts-capture.config.json
    // stacks user globs on top (additive, last-match-wins, leading `!`
    // re-includes).
    describe("configurable skip files (apply.skipFiles)", () => {
      it("skips a non-test file matched by a configured glob", () => {
        withTmpDir((dir) => {
          fs.writeFileSync(
            path.join(dir, "ts-capture.config.json"),
            JSON.stringify({ apply: { skipFiles: ["**/*.gen.ts"] } }),
          );
          const genFile = path.join(dir, "api.gen.ts");
          fs.writeFileSync(genFile, FOO);

          const typeInfo = [[genFile, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(genFile, "utf-8")).toBe(FOO);
        });
      });

      it("a configured glob does not affect non-matching files", () => {
        withTmpDir((dir) => {
          fs.writeFileSync(
            path.join(dir, "ts-capture.config.json"),
            JSON.stringify({ apply: { skipFiles: ["**/*.gen.ts"] } }),
          );
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);

          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fileAfter(file, FOO)).toAnnotate("a", "string");
        });
      });

      it("expands brace groups in a configured glob", () => {
        withTmpDir((dir) => {
          fs.writeFileSync(
            path.join(dir, "ts-capture.config.json"),
            JSON.stringify({ apply: { skipFiles: ["**/*.{gen,generated}.ts"] } }),
          );
          const genFile = path.join(dir, "api.generated.ts");
          fs.writeFileSync(genFile, FOO);

          const typeInfo = [[genFile, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(genFile, "utf-8")).toBe(FOO);
        });
      });

      it("a leading `!` re-includes a spec file the default would skip", () => {
        withTmpDir((dir) => {
          fs.writeFileSync(
            path.join(dir, "ts-capture.config.json"),
            JSON.stringify({ apply: { skipFiles: ["!keep.spec.ts"] } }),
          );
          const keep = path.join(dir, "keep.spec.ts");
          const other = path.join(dir, "other.spec.ts");
          fs.writeFileSync(keep, FOO);
          fs.writeFileSync(other, "function bar(a) { return a; }");

          const typeInfo = [
            [keep, 14, [["string", undefined]], {}],
            [other, 14, [["string", undefined]], {}],
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          // re-included by negation
          expect(fileAfter(keep, FOO)).toAnnotate("a", "string");
          // still skipped by the built-in default
          expect(fileAfter(other, "function bar(a) { return a; }")).toLeaveUntyped("a");
        });
      });
    });

    // Preview mode that lets users see what would change before
    // committing. Defense-in-depth: even if ts-capture still has
    // unhandled regression edges, dry-run gives a chance to inspect
    // the diff before writing.
    describe("--dry-run", () => {
      it("does not modify files when --dry-run is set", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);

          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stdout } = run("apply", jsonFile, "--dry-run");
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toBe(FOO);
          // Output should mention the file that would have been changed
          expect(stdout).toContain(file);
        });
      });

      it("prints the lines it would change as a diff", () => {
        withTmpDir((rawDir) => {
          const dir = fs.realpathSync(rawDir);
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, `${FOO}\n`);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify([[file, 14, [["string", undefined]], {}]]));

          const { stdout } = runInDir(dir, "apply", jsonFile, "--dry-run");

          expect(stdout).toContain(
            [
              "--- a/lib.ts",
              "+++ b/lib.ts",
              "@@ -1,1 +1,1 @@",
              "-function foo(a) { return a; }",
              "+function foo(a: string) { return a; }",
            ].join("\n"),
          );
        });
      });

      it("reports files that would NOT change separately from changed", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);

          // Empty types array → result will equal source → no-change
          const typeInfo = [[file, 14, [], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stdout } = run("apply", jsonFile, "--dry-run");
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toBe(FOO);
          // Reports something useful (a "0 files would change" or similar
          // summary). We assert "no" appears since the wording will likely
          // be like "no changes" — keeps the assertion loose so future
          // wording tweaks don't break tests.
          expect(stdout.toLowerCase()).toMatch(/no.*chang|0 file/);
        });
      });
    });

    // Multi-entry idempotency via sidecar manifest. The in-source
    // pos-based idempotency in applyTypesToFile handles the
    // single-entry case; this closes the multi-entry case. Manifest
    // sits next to types.json, named <types.json>.applied, with sha256
    // of the types.json content. On re-apply, if the manifest matches,
    // exit no-op. --force bypasses.
    describe("idempotency manifest (multi-entry)", () => {
      it("writes a manifest after apply", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, "function foo(a, b) { return a; }");
          const typeInfo = [
            [file, 14, [["number", undefined]], {}],
            [file, 17, [["string", undefined]], {}],
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);

          // Manifest file exists next to types.json
          const manifestPath = jsonFile + ".applied";
          expect(fs.existsSync(manifestPath)).toBe(true);
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
          expect(manifest.version).toBe(1);
          expect(manifest.typeInfoHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        });
      });

      it("re-running apply with same types.json is a no-op (multi-entry)", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, "function foo(a, b) { return a; }");
          const typeInfo = [
            [file, 14, [["number", undefined]], {}],
            [file, 17, [["string", undefined]], {}],
          ];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          // First apply: should annotate both params
          run("apply", jsonFile);
          const after1 = fs.readFileSync(file, "utf-8");
          const first = checked("function foo(a, b) { return a; }", after1);
          expect(first).toAnnotate("a", "number");
          expect(first).toAnnotate("b", "string");

          // Second apply: should be a no-op even though the in-source
          // pos-based check can't catch the second entry's shift.
          const { exitCode, stdout } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          const after2 = fs.readFileSync(file, "utf-8");
          expect(after2).toBe(after1);
          expect(stdout.toLowerCase()).toMatch(/already applied|skip/);
        });
      });

      // `--infer.outputMode=comments` worked from the day the mode existed,
      // through the generic override — which is to say it was findable by
      // people who already knew it was there.
      it("--comments is the preview mode", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify([[file, 14, [["number", undefined]], {}]]));

          expect(run("apply", jsonFile, "--comments").exitCode).toBe(0);
          const after = fileAfter(file, FOO);
          expect(after.text).toContain("@ts-capture[proposal]: `a` would be `number`");
          expect(after).toLeaveUntyped("a");
        });
      });

      it("--both writes the annotation and the note", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify([[file, 14, [["number", undefined]], {}]]));

          expect(run("apply", jsonFile, "--both").exitCode).toBe(0);
          const after = fileAfter(file, FOO);
          expect(after.text).toContain("@ts-capture[applied]: `a` observed once");
          expect(after).toAnnotate("a", "number");
        });
      });

      // The explicit option is the one that wins: a flag is a shorthand for it,
      // not a second source of truth.
      it("--infer.outputMode overrides the shorthand", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify([[file, 14, [["number", undefined]], {}]]));

          run("apply", jsonFile, "--comments", "--infer.outputMode=annotations");
          const after = fileAfter(file, FOO);
          expect(after).toAnnotate("a", "number");
          expect(after.text).not.toContain("@ts-capture");
        });
      });

      // The preview writes the file but annotates nothing, so it is neither a
      // dry run nor an apply — and the manifest had no third case. It claimed
      // the types.json was applied, which closed the one workflow the mode
      // exists for: look at the proposals, then take them.
      it("a preview does not claim the types.json was applied", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify([[file, 14, [["number", undefined]], {}]]));

          const preview = run("apply", jsonFile, "--infer.outputMode=comments");
          expect(preview.exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toContain("@ts-capture[proposal]");
          expect(fs.existsSync(jsonFile + ".applied")).toBe(false);

          // The point of the whole thing: the apply that follows lands.
          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          const after = fileAfter(file, FOO);
          expect(after).toAnnotate("a", "number");
          expect(after.text).not.toContain("@ts-capture");
        });
      });

      // A run that annotates nothing has nothing to short-circuit on a second
      // pass either, and saying otherwise is the same untruth.
      it("an apply that writes no annotation writes no manifest", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, "const a = 1;\n");
          const jsonFile = path.join(dir, "types.json");
          // `number` is what TypeScript already infers — suppressed.
          fs.writeFileSync(
            jsonFile,
            JSON.stringify([[file, 7, [["number", undefined]], { varDecl: true }]]),
          );

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toBe("const a = 1;\n");
          expect(fs.existsSync(jsonFile + ".applied")).toBe(false);
        });
      });

      it("re-running with a different types.json applies normally", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);

          // First apply with one entry
          const ti1 = [[file, 14, [["number", undefined]], {}]];
          const json1 = path.join(dir, "v1.json");
          fs.writeFileSync(json1, JSON.stringify(ti1));
          run("apply", json1);
          expect(fileAfter(file, FOO)).toAnnotate("a", "number");

          // Different types.json with the same hash-key — should still apply
          // since manifest is keyed per-types.json-path.
          const ti2 = [[file, 14, [["string", undefined]], {}]];
          const json2 = path.join(dir, "v2.json");
          fs.writeFileSync(json2, JSON.stringify(ti2));
          const { exitCode } = run("apply", json2);
          expect(exitCode).toBe(0);
          // The single-entry pos check skips the v2 apply since pos 14
          // already has `:`. That's fine — confirms single-entry idempotency
          // still works alongside the manifest.
          // (More interesting: a different types.json that targets a
          // DIFFERENT pos would actually apply; tested elsewhere.)
        });
      });

      it("--force bypasses the manifest idempotency check", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);
          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          run("apply", jsonFile);
          // Sidecar exists now. With --force, re-apply runs the loop
          // (per-entry pos-check still skips, so result is identical).
          const { exitCode, stdout } = run("apply", jsonFile, "--force");
          expect(exitCode).toBe(0);
          // No "already applied" short-circuit message.
          expect(stdout.toLowerCase()).not.toMatch(/already applied/);
        });
      });

      it("dry-run does NOT write a manifest", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, FOO);
          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          run("apply", jsonFile, "--dry-run");
          expect(fs.existsSync(jsonFile + ".applied")).toBe(false);
        });
      });
    });

    // Source modified between collect and apply. Collection captures
    // positions valid for source v1; user then edits the source to v2
    // (different offsets, possibly incompatible structure); apply runs
    // against v2. ts-capture must NOT silently produce a corrupted
    // file — the resulting source should either remain valid TypeScript
    // (positions happened to still work) or the CLI should refuse the
    // apply.
    describe("source modified between collect and apply", () => {
      it("does not corrupt the source when offsets point at insertions added after collect", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          // Collect-time source: parameter `a` is at offset 13.
          fs.writeFileSync(file, FOO);
          const typeInfo = [[file, 13, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          // Apply-time: user has prepended a comment + an additional fn,
          // so the original `a` is now at a much later offset and the
          // collected position 13 points into the unrelated prefix code.
          const v2 =
            "// added comment\nexport function bar(b) { return b; }\nfunction foo(a) { return a; }";
          fs.writeFileSync(file, v2);

          const { exitCode } = run("apply", jsonFile);
          const after = fs.readFileSync(file, "utf-8");
          // Either the run went through and produced TypeScript that parses,
          // or it exited non-zero and left the file alone. Both are
          // acceptable; silent corruption is not.
          if (exitCode === 0) {
            expect(parseErrors(checked(v2, after))).toEqual([]);
          } else {
            // Acceptable alternative: refuse and exit non-zero. File
            // should be left as-is (or at least still valid TS).
            expect(after).toBe(v2);
          }
        });
      });

      it("does not corrupt the source when the original token at offset has been deleted", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          // v1: parameter at offset 13.
          fs.writeFileSync(file, FOO);
          const typeInfo = [[file, 13, [["number", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          // v2: function renamed and parameter is now elsewhere.
          // Position 13 in v2 is in the middle of `quux`, not a
          // parameter declaration — apply must refuse or no-op here.
          const v2 = "export const quux = 1;\nfunction foo(a) { return a; }";
          fs.writeFileSync(file, v2);

          const { exitCode } = run("apply", jsonFile);
          const after = fs.readFileSync(file, "utf-8");
          if (exitCode === 0) {
            expect(parseErrors(checked(v2, after))).toEqual([]);
          } else {
            expect(after).toBe(v2);
          }
        });
      });
    });
  });

  describe("merge", () => {
    // Vitest's default forks pool produces one ts-capture-types-<pid>.json per
    // spec file, so a real test run yields N dumps that need to be merged
    // into a single types.json before `apply`. Smoke-test.sh and the hono
    // eval each had to inline a node -e "..." merge step. The `merge`
    // subcommand bakes that in.

    it("merges all ts-capture-types-*.json files in a directory to stdout", () => {
      withTmpDir((dir) => {
        const dump1 = [["a.ts", 10, [["string"]], {}]];
        const dump2 = [["b.ts", 20, [["number"]], {}]];
        fs.writeFileSync(path.join(dir, "ts-capture-types-101.json"), JSON.stringify(dump1));
        fs.writeFileSync(path.join(dir, "ts-capture-types-202.json"), JSON.stringify(dump2));

        const { stdout, exitCode } = run("merge", dir);
        expect(exitCode).toBe(0);
        const merged = JSON.parse(stdout);
        expect(merged).toHaveLength(2);
        // Order doesn't matter — assert both entries are present
        expect(merged.map((e: unknown[]) => e[0]).sort()).toEqual(["a.ts", "b.ts"]);
      });
    });

    it("ignores non-ts-capture-types-*.json files in the directory", () => {
      withTmpDir((dir) => {
        const dump = [["a.ts", 10, [["string"]], {}]];
        fs.writeFileSync(path.join(dir, "ts-capture-types-1.json"), JSON.stringify(dump));
        // Decoy files that should NOT be picked up
        fs.writeFileSync(path.join(dir, "package.json"), `{"name": "x"}`);
        fs.writeFileSync(
          path.join(dir, "types.json"),
          JSON.stringify([["b.ts", 20, [["number"]], {}]]),
        );
        fs.writeFileSync(
          path.join(dir, "ts-capture-types.json"),
          JSON.stringify([["c.ts", 30, [["boolean"]], {}]]),
        );

        const { stdout, exitCode } = run("merge", dir);
        expect(exitCode).toBe(0);
        const merged = JSON.parse(stdout);
        expect(merged).toHaveLength(1);
        expect(merged[0][0]).toBe("a.ts");
      });
    });

    it("merges from an explicit list of files", () => {
      withTmpDir((dir) => {
        const f1 = path.join(dir, "one.json");
        const f2 = path.join(dir, "two.json");
        fs.writeFileSync(f1, JSON.stringify([["a.ts", 1, [["string"]], {}]]));
        fs.writeFileSync(f2, JSON.stringify([["b.ts", 2, [["number"]], {}]]));

        const { stdout, exitCode } = run("merge", f1, f2);
        expect(exitCode).toBe(0);
        const merged = JSON.parse(stdout);
        expect(merged).toHaveLength(2);
      });
    });

    it("--out writes to a file instead of stdout", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(
          path.join(dir, "ts-capture-types-1.json"),
          JSON.stringify([["a.ts", 10, [["string"]], {}]]),
        );
        const outPath = path.join(dir, "merged.json");

        const { stdout, exitCode } = run("merge", dir, "--out", outPath);
        expect(exitCode).toBe(0);
        // stdout should be a summary, NOT JSON
        expect(stdout).not.toContain('"a.ts"');
        // File should exist with content
        expect(fs.existsSync(outPath)).toBe(true);
        const merged = JSON.parse(fs.readFileSync(outPath, "utf-8"));
        expect(merged).toHaveLength(1);
        expect(merged[0][0]).toBe("a.ts");
      });
    });

    it("exits with 1 when given a directory containing no ts-capture-types-*.json", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "irrelevant.json"), `{}`);
        const { exitCode } = run("merge", dir);
        expect(exitCode).toBe(1);
      });
    });

    it("exits with 1 when given a non-existent path", () => {
      const { exitCode } = run("merge", "/nonexistent/path");
      expect(exitCode).toBe(1);
    });

    it("streaming output matches the all-in-memory equivalent byte-for-byte", () => {
      // cmdMerge writes entries incrementally instead of building a
      // single in-memory merged array + stringifying once. Output
      // format must be identical.
      withTmpDir((dir) => {
        const dump1 = [
          ["a.ts", 10, [["string"]], {}],
          ["a.ts", 20, [["number"]], { varDecl: true }],
        ];
        const dump2 = [["b.ts", 5, [["boolean"]], { returnType: true }]];
        const dump3 = [
          ["c.ts", 1, [["{ x: number, y: string }"]], {}],
          ["c.ts", 2, [["Cat /* @sa:Animal */"]], { varDecl: true }],
        ];
        fs.writeFileSync(path.join(dir, "ts-capture-types-1.json"), JSON.stringify(dump1));
        fs.writeFileSync(path.join(dir, "ts-capture-types-2.json"), JSON.stringify(dump2));
        fs.writeFileSync(path.join(dir, "ts-capture-types-3.json"), JSON.stringify(dump3));

        const { stdout, exitCode } = run("merge", dir);
        expect(exitCode).toBe(0);

        // Reference: what the old all-in-memory implementation would
        // have produced from the same inputs.
        const reference = [
          ...JSON.parse(fs.readFileSync(path.join(dir, "ts-capture-types-1.json"), "utf-8")),
          ...JSON.parse(fs.readFileSync(path.join(dir, "ts-capture-types-2.json"), "utf-8")),
          ...JSON.parse(fs.readFileSync(path.join(dir, "ts-capture-types-3.json"), "utf-8")),
        ];
        // The merge command sorts dump files by readdir order, which
        // happens to be the file-creation order on macOS but isn't
        // guaranteed across filesystems. Compare as parsed JSON
        // (sets of entries, order-independent on the file dimension).
        const merged = JSON.parse(stdout);
        expect(merged).toHaveLength(reference.length);
        for (const entry of reference) {
          expect(merged).toContainEqual(entry);
        }
      });
    });

    it("handles many small dump files without OOM (sanity check)", () => {
      // Synthetic stand-in for the large-monorepo case the prior tracking
      // calls out. Doesn't actually measure memory — that's hard
      // to test reliably across machines — but does exercise the
      // many-files path end-to-end so any "all entries collected
      // first" regression would surface as a slowdown / output
      // corruption.
      withTmpDir((dir) => {
        const N = 500;
        for (let i = 0; i < N; i++) {
          fs.writeFileSync(
            path.join(dir, `ts-capture-types-${i}.json`),
            JSON.stringify([[`f${i}.ts`, i, [["string"]], {}]]),
          );
        }
        const { stdout, exitCode } = run("merge", dir);
        expect(exitCode).toBe(0);
        const merged = JSON.parse(stdout);
        expect(merged).toHaveLength(N);
        // Spot-check that one of the entries actually came through
        // with its file name intact.
        expect(merged.some((e: unknown[]) => e[0] === "f250.ts")).toBe(true);
      });
    });

    it("emits an empty array `[]` when all dump files contain `[]`", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "ts-capture-types-1.json"), "[]");
        fs.writeFileSync(path.join(dir, "ts-capture-types-2.json"), "[]");
        const { stdout, exitCode } = run("merge", dir);
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe("[]");
      });
    });

    it("--out file output is parseable JSON (no stray separator at the seams)", () => {
      // Streaming write joins entries with `,` separators, with a
      // bookkeeping flag to skip the leading comma. Off-by-one here
      // would produce `[,...]` or `[...,]` (both invalid JSON).
      // Verify the file parses cleanly with a single dump and with
      // multiple dumps.
      withTmpDir((dir) => {
        fs.writeFileSync(
          path.join(dir, "ts-capture-types-1.json"),
          JSON.stringify([["a.ts", 1, [["string"]], {}]]),
        );
        fs.writeFileSync(
          path.join(dir, "ts-capture-types-2.json"),
          JSON.stringify([["b.ts", 2, [["number"]], {}]]),
        );
        const outPath = path.join(dir, "out.json");
        const { exitCode } = run("merge", dir, "--out", outPath);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(fs.readFileSync(outPath, "utf-8"));
        expect(parsed).toHaveLength(2);
      });
    });
  });

  describe("coverage", () => {
    it("reports type coverage for a tsconfig", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "test.ts"), "const x: number = 1;");
        fs.writeFileSync(
          path.join(dir, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { strict: true }, include: ["test.ts"] }),
        );
        const { stdout, exitCode } = run("coverage", path.join(dir, "tsconfig.json"));
        expect(exitCode).toBe(0);
        expect(stdout).toMatch(/\d+(\.\d+)?%/);
      });
    });

    it("exits with 1 when tsconfig not found", () => {
      const { exitCode } = run("coverage", "/nonexistent/tsconfig.json");
      expect(exitCode).toBe(1);
    });
  });

  describe("apply-bundle", () => {
    it("types the source parameters behind a bundle's observations", async () => {
      const { SourceMapGenerator } = await import("source-map");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-cli-"));
      try {
        const source = "export function add(a, b) { return a + b; }\n";
        fs.writeFileSync(path.join(dir, "src.ts"), source);
        // Minified, as a bundler would leave it; the map leads back to the names.
        const bundle = "function add(r,e){return r+e}\n";
        fs.writeFileSync(path.join(dir, "bundle.js"), bundle);
        const map = new SourceMapGenerator({ file: "bundle.js" });
        for (const [mangled, name] of [
          ["r,", "a,"],
          ["e)", "b)"],
        ]) {
          map.addMapping({
            source: "src.ts",
            original: { line: 1, column: source.indexOf(name) },
            generated: { line: 1, column: bundle.indexOf(mangled) },
          });
        }
        fs.writeFileSync(path.join(dir, "bundle.js.map"), map.toString());
        const bundlePath = path.join(dir, "bundle.js");
        fs.writeFileSync(
          path.join(dir, "observations.json"),
          JSON.stringify([
            { name: "r", pos: bundle.indexOf("r,"), file: bundlePath, type: "number" },
            { name: "e", pos: bundle.indexOf("e)"), file: bundlePath, type: "number" },
          ]),
        );

        const { stdout, exitCode } = run(
          "apply-bundle",
          path.join(dir, "observations.json"),
          "--map",
          path.join(dir, "bundle.js.map"),
        );

        expect(exitCode).toBe(0);
        expect(stdout).toContain("2 translated");
        const out = checked(source, fs.readFileSync(path.join(dir, "src.ts"), "utf-8"));
        expect(out).toAnnotate("a", "number");
        expect(out).toAnnotate("b", "number");
        expect(out).toHaveNoNewDiagnostics();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
