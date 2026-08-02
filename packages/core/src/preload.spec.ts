import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The preload mutates globalThis and registers process listeners; load it
// exactly once per test process and share the resulting __tscptr__ surface
// across the suite. Resetting modules and re-loading would accumulate
// listeners and ticker intervals — the in-process integration tests below
// are designed around the single-load assumption.
const PRELOAD_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/preload.cjs",
);
const require = createRequire(import.meta.url);

interface TscptrFn {
  (name: string, value: unknown, pos: number, filename: string, optsJson: string): void;
  ret: <T>(value: T, pos: number, filename: string, optsJson: string) => T;
  track: <T>(value: T, filename: string, offset: number) => T;
  registerFn: (fn: Function, retPos: number, filename: string) => void;
  regFn: <F extends Function>(fn: F, retPos: number, filename: string) => F;
}

describe("@ts-capture/core/preload", () => {
  let tmpDir: string;
  let outFile: string;
  let tscptr: TscptrFn;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-runtime-test-"));
    // Set every literal-option env var so the corresponding branches are
    // exercised by the literalOptions resolver in preload.cjs.
    process.env.TS_CAPTURE_TYPES_DIR = tmpDir;
    process.env.TS_CAPTURE_LITERAL_STRING = "true";
    process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH = "8";
    process.env.TS_CAPTURE_LITERAL_NUMBER = "true";
    process.env.TS_CAPTURE_LITERAL_BOOLEAN = "true";
    process.env.TS_CAPTURE_MAX_ANNOTATION_CHARS = "2048";
    require(PRELOAD_PATH);
    tscptr = (globalThis as unknown as { __tscptr__: TscptrFn }).__tscptr__;
  });

  // Helper: locate the runtime's per-process dump file in tmpDir. The
  // runtime uses a UUID-based filename (UUID avoids the
  // worker_threads PID-collision case), so tests can't compute the
  // path up front; resolve via directory listing after the first
  // flush.
  function findDumpFile(): string {
    const dumps = fs
      .readdirSync(tmpDir)
      .filter((f) => /^ts-capture-types-[0-9a-f-]+\.json$/i.test(f));
    if (dumps.length !== 1) {
      throw new Error(
        `expected exactly one dump file in ${tmpDir}, got ${dumps.length}: ${dumps.join(", ")}`,
      );
    }
    return path.join(tmpDir, dumps[0]);
  }

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TS_CAPTURE_TYPES_DIR;
    delete process.env.TS_CAPTURE_LITERAL_STRING;
    delete process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH;
    delete process.env.TS_CAPTURE_LITERAL_NUMBER;
    delete process.env.TS_CAPTURE_LITERAL_BOOLEAN;
    delete process.env.TS_CAPTURE_MAX_ANNOTATION_CHARS;
  });

  describe("globalThis.__tscptr__ surface", () => {
    it("registers __tscptr__ as a function with all instrument-time methods", () => {
      expect(typeof tscptr).toBe("function");
      expect(typeof tscptr.track).toBe("function");
      expect(typeof tscptr.ret).toBe("function");
      expect(typeof tscptr.registerFn).toBe("function");
    });

    it("__tscptr__.ret passes the value through", () => {
      const obj = { x: 1 };
      const result = tscptr.ret(obj, 100, "/test/file.ts", "{}");
      expect(result).toBe(obj);
      const primitive = tscptr.ret(42, 101, "/test/file.ts", "{}");
      expect(primitive).toBe(42);
    });

    it("__tscptr__.track is callable without throwing", () => {
      expect(() => tscptr.track("v", "/test/file.ts", 0)).not.toThrow();
    });

    it("__tscptr__.registerFn is callable without throwing", () => {
      function example() {}
      expect(() => tscptr.registerFn(example, 5, "/test/file.ts")).not.toThrow();
    });

    it("__tscptr__.regFn registers and returns the function for chaining", () => {
      function example() {}
      const result = tscptr.regFn(example, 6, "/test/file.ts");
      expect(result).toBe(example);
    });
  });

  describe("flush + per-process dump", () => {
    it("records observed values to per-process JSON dump after flush", () => {
      tscptr("name", "hello", 200, "/test/file.ts", "{}");
      tscptr("name", 42, 201, "/test/file.ts", "{}");
      // beforeExit is one of the four signals registered as a flush handler
      // in preload.cjs; emitting it fires flush synchronously without waiting
      // for the 500ms ticker.
      process.emit("beforeExit", 0);
      outFile = findDumpFile();
      expect(fs.existsSync(outFile)).toBe(true);
      const dump = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      expect(Array.isArray(dump)).toBe(true);
      expect(dump.length).toBeGreaterThan(0);
    });

    it("flush is a no-op when no new observations since last flush", () => {
      const before = fs.statSync(outFile).mtimeMs;
      // Nothing recorded between this flush and the previous one — the
      // lastFlushedSize early-return branch should prevent a rewrite.
      process.emit("beforeExit", 0);
      const after = fs.statSync(outFile).mtimeMs;
      expect(after).toBe(before);
    });
  });

  // In-process tests for the flush() failure paths. The subprocess tests
  // below verify the same behavior in a real Node preload context, but
  // subprocess coverage doesn't merge into the v8 report — these tests
  // close the in-process coverage gap on the writeFileSync catch (lines
  // ~98-107 of preload.cjs) and the inner stderr.write catch.
  //
  // Ordering note: the runtime is loaded once in beforeAll, so the
  // module-scoped `warnedWriteFailure` flag persists across tests. This
  // describe must run AFTER `flush + per-process dump` (which needs
  // clean successful flushes) and the subprocess block below is
  // unaffected since it spawns fresh Node processes.
  describe("in-process flush failure paths", () => {
    it("warns once on writeFileSync failure and survives a broken stderr.write", () => {
      // First flush: both fs.writeFileSync and process.stderr.write fail.
      // The runtime should swallow both via its outer + inner catch and
      // still set the one-shot guard. No exception should escape.
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
        throw new Error("EACCES: simulated permission denied");
      });
      const brokenStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
        throw new Error("stderr broken too");
      });
      try {
        tscptr("inproc-warn-1", "v1", 9001, "/test/file.ts", "{}");
        expect(() => process.emit("beforeExit", 0)).not.toThrow();
      } finally {
        brokenStderr.mockRestore();
      }

      // Second flush: writeFileSync still fails, but stderr.write works.
      // The one-shot guard set on the previous flush should suppress any
      // further warning — verify no "failed to write" lands on stderr.
      const captured: string[] = [];
      const captureStderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: unknown) => {
          captured.push(typeof chunk === "string" ? chunk : String(chunk));
          return true;
        });
      try {
        tscptr("inproc-warn-2", "v2", 9002, "/test/file.ts", "{}");
        process.emit("beforeExit", 0);
        const occurrences = captured.filter((s) =>
          s.includes("[ts-capture] failed to write"),
        ).length;
        expect(occurrences).toBe(0);
      } finally {
        captureStderr.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  describe("preload via NODE_OPTIONS (subprocess)", () => {
    // Regression: TS_CAPTURE_TYPES_DIR pointing to a non-existent path
    // used to result in 0 dumps because writeFileSync threw ENOENT and
    // the silent best-effort catch swallowed it. Now the runtime
    // mkdirSyncs the dir at init.
    // Regression: writeFileSync failures (permission-denied, disk-full,
    // unmounted volume) silently lost data even with auto-mkdir. Now a
    // one-shot stderr warning surfaces the failure. The repeat-flush
    // case must NOT spam — only one warning per process.
    it("emits one-shot stderr warning when writeFileSync fails", () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-runtime-warn-"));
      // Point TS_CAPTURE_TYPES_DIR at a FILE, not a dir — auto-mkdir will
      // succeed (mkdirSync no-ops on existing path), but writeFileSync
      // fails because the resolved OUT_FILE includes a path component
      // that already exists as a regular file. Reliable cross-platform
      // way to provoke an EEXIST/ENOTDIR-class write failure without
      // chmod hackery.
      const typesDir = path.join(parent, "not-a-dir");
      fs.writeFileSync(typesDir, "blocker");
      try {
        const result = spawnSync(
          process.execPath,
          [
            "--require",
            PRELOAD_PATH,
            "-e",
            // Trigger many flushes; warning must fire exactly once.
            "for (let i = 0; i < 20; i++) globalThis.__tscptr__('p' + i, i, i, '/x.ts', '{}'); process.exit(0);",
          ],
          {
            env: { ...process.env, TS_CAPTURE_TYPES_DIR: typesDir },
            encoding: "utf-8",
          },
        );
        expect(result.status).toBe(0);
        // Stderr should have the warning exactly once.
        const occurrences = (result.stderr.match(/\[ts-capture\] failed to write/g) ?? []).length;
        expect(occurrences).toBe(1);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });

    it("auto-creates TS_CAPTURE_TYPES_DIR if it doesn't exist", () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-runtime-mkdir-"));
      const typesDir = path.join(parent, "does-not-exist-yet");
      try {
        expect(fs.existsSync(typesDir)).toBe(false);
        const result = spawnSync(
          process.execPath,
          [
            "--require",
            PRELOAD_PATH,
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
          .filter((f) => f.startsWith("ts-capture-types-") && f.endsWith(".json"));
        expect(dumps.length).toBe(1);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });

    it("a preloaded child process records and flushes its own dump", () => {
      const childTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-runtime-child-"));
      try {
        const result = spawnSync(
          process.execPath,
          [
            "--require",
            PRELOAD_PATH,
            "-e",
            "globalThis.__tscptr__('p', 'hello', 0, '/x.ts', '{}'); " +
              "globalThis.__tscptr__.ret(42, 1, '/x.ts', '{}'); " +
              "process.exit(0);",
          ],
          {
            env: { ...process.env, TS_CAPTURE_TYPES_DIR: childTmp },
            encoding: "utf-8",
          },
        );
        expect(result.status).toBe(0);
        const dumps = fs
          .readdirSync(childTmp)
          .filter((f) => f.startsWith("ts-capture-types-") && f.endsWith(".json"));
        expect(dumps).toHaveLength(1);
        const dump = JSON.parse(fs.readFileSync(path.join(childTmp, dumps[0]), "utf-8"));
        expect(Array.isArray(dump)).toBe(true);
        expect(dump.length).toBeGreaterThan(0);
      } finally {
        fs.rmSync(childTmp, { recursive: true, force: true });
      }
    });
  });
});
