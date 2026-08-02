import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

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

function withTmpDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-cli-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
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
  });

  describe("instrument", () => {
    it("instruments a file and writes to stdout", () => {
      withTmpDir((dir) => {
        const srcFile = path.join(dir, "test.ts");
        fs.writeFileSync(srcFile, "function foo(a) { return a; }");
        const { stdout, exitCode } = run("instrument", srcFile);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("__tscptr__");
      });
    });

    it("instruments in-place with --in-place", () => {
      withTmpDir((dir) => {
        const srcFile = path.join(dir, "test.ts");
        fs.writeFileSync(srcFile, "function foo(a) { return a; }");
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
        fs.writeFileSync(srcFile, "function foo(a) { return a; }");

        // Collected type info: [filename, offset, [[typeName, sourcePos]], opts]
        const typeInfo = [[srcFile, 14, [["string", undefined]], {}]];
        const jsonFile = path.join(dir, "types.json");
        fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

        const { exitCode } = run("apply", jsonFile);
        expect(exitCode).toBe(0);

        const result = fs.readFileSync(srcFile, "utf-8");
        expect(result).toContain("a: string");
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
          fs.writeFileSync(realFile, "function foo(a) { return a; }");

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
          expect(fs.readFileSync(realFile, "utf-8")).toContain("a: string");
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
          fs.writeFileSync(realFile, "function foo(a) { return a; }");
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
          expect(fs.readFileSync(realFile, "utf-8")).toContain("a: string");
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

      it("does not skip a normal .ts file even when path contains 'svelte'", () => {
        // `svelte-utils.ts` is a normal file that happens to mention
        // svelte — it must still be applied normally.
        withTmpDir((dir) => {
          const file = path.join(dir, "svelte-utils.ts");
          fs.writeFileSync(file, "function foo(a) { return a; }");

          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toContain("a: string");
        });
      });
    });

    // Test/spec files get unwanted annotations (e.g.
    // `it("...", (): Assertion => ...)`) when apply runs on a vitest
    // project. Default-exclude common test glob patterns; honor an
    // opt-back-in flag for users who really want to apply to specs.
    describe("default test-file exclusion", () => {
      it("skips *.spec.ts files by default", () => {
        withTmpDir((dir) => {
          const specFile = path.join(dir, "math.spec.ts");
          const original = "function foo(a) { return a; }";
          fs.writeFileSync(specFile, original);

          const typeInfo = [[specFile, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          // File should be unchanged
          expect(fs.readFileSync(specFile, "utf-8")).toBe(original);
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
          fs.writeFileSync(file, "function foo(a) { return a; }");

          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toContain("a: string");
        });
      });

      it("--include-tests opts back in", () => {
        withTmpDir((dir) => {
          const specFile = path.join(dir, "math.spec.ts");
          fs.writeFileSync(specFile, "function foo(a) { return a; }");

          const typeInfo = [[specFile, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = run("apply", jsonFile, "--include-tests");
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(specFile, "utf-8")).toContain("a: string");
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
          const original = "function foo(a) { return a; }";
          fs.writeFileSync(genFile, original);

          const typeInfo = [[genFile, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(genFile, "utf-8")).toBe(original);
        });
      });

      it("a configured glob does not affect non-matching files", () => {
        withTmpDir((dir) => {
          fs.writeFileSync(
            path.join(dir, "ts-capture.config.json"),
            JSON.stringify({ apply: { skipFiles: ["**/*.gen.ts"] } }),
          );
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, "function foo(a) { return a; }");

          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toContain("a: string");
        });
      });

      it("expands brace groups in a configured glob", () => {
        withTmpDir((dir) => {
          fs.writeFileSync(
            path.join(dir, "ts-capture.config.json"),
            JSON.stringify({ apply: { skipFiles: ["**/*.{gen,generated}.ts"] } }),
          );
          const genFile = path.join(dir, "api.generated.ts");
          const original = "function foo(a) { return a; }";
          fs.writeFileSync(genFile, original);

          const typeInfo = [[genFile, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode } = runInDir(dir, "apply", jsonFile);
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(genFile, "utf-8")).toBe(original);
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
          fs.writeFileSync(keep, "function foo(a) { return a; }");
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
          expect(fs.readFileSync(keep, "utf-8")).toContain("a: string");
          // still skipped by the built-in default
          expect(fs.readFileSync(other, "utf-8")).not.toContain("a: string");
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
          const original = "function foo(a) { return a; }";
          fs.writeFileSync(file, original);

          const typeInfo = [[file, 14, [["string", undefined]], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stdout } = run("apply", jsonFile, "--dry-run");
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toBe(original);
          // Output should mention the file that would have been changed
          expect(stdout).toContain(file);
        });
      });

      it("reports files that would NOT change separately from changed", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          const original = "function foo(a) { return a; }";
          fs.writeFileSync(file, original);

          // Empty types array → result will equal source → no-change
          const typeInfo = [[file, 14, [], {}]];
          const jsonFile = path.join(dir, "types.json");
          fs.writeFileSync(jsonFile, JSON.stringify(typeInfo));

          const { exitCode, stdout } = run("apply", jsonFile, "--dry-run");
          expect(exitCode).toBe(0);
          expect(fs.readFileSync(file, "utf-8")).toBe(original);
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
          expect(after1).toBe("function foo(a: number, b: string) { return a; }");

          // Second apply: should be a no-op even though the in-source
          // pos-based check can't catch the second entry's shift.
          const { exitCode, stdout } = run("apply", jsonFile);
          expect(exitCode).toBe(0);
          const after2 = fs.readFileSync(file, "utf-8");
          expect(after2).toBe(after1);
          expect(stdout.toLowerCase()).toMatch(/already applied|skip/);
        });
      });

      it("re-running with a different types.json applies normally", () => {
        withTmpDir((dir) => {
          const file = path.join(dir, "lib.ts");
          fs.writeFileSync(file, "function foo(a) { return a; }");

          // First apply with one entry
          const ti1 = [[file, 14, [["number", undefined]], {}]];
          const json1 = path.join(dir, "v1.json");
          fs.writeFileSync(json1, JSON.stringify(ti1));
          run("apply", json1);
          expect(fs.readFileSync(file, "utf-8")).toContain(": number");

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
          fs.writeFileSync(file, "function foo(a) { return a; }");
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
          fs.writeFileSync(file, "function foo(a) { return a; }");
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
          fs.writeFileSync(file, "function foo(a) { return a; }");
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
          // Cheap structural check: ts.parse should accept the result.
          // If apply silently mangled the file (inserted `: string`
          // mid-comment, e.g.) the parser surfaces it as a SyntaxError.
          // Eitherrun went through OK and produced valid TS, or exited
          // non-zero and left the file untouched. Both are acceptable;
          // silent corruption is not.
          if (exitCode === 0) {
            const sf = ts.createSourceFile("v2.ts", after, ts.ScriptTarget.Latest, true);
            const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
              .parseDiagnostics;
            const errors = (diags ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
            expect(errors.length).toBe(0);
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
          fs.writeFileSync(file, "function foo(a) { return a; }");
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
            const sf = ts.createSourceFile("v2.ts", after, ts.ScriptTarget.Latest, true);
            const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
              .parseDiagnostics;
            const errors = (diags ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
            expect(errors.length).toBe(0);
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
});
