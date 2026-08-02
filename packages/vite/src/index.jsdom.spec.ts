import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
// @vitest-environment jsdom
//
// Real-jsdom integration test for the collector snippet's environment
// auto-detect. Under Vitest with `environment: "jsdom"`, both
// `window` (from jsdom) and `process` (from Node) are defined. A
// naive IS_BROWSER-first branch sends observations to a beacon that
// nobody listens to → 0 dumps. The collector branches IS_NODE first
// and exposes an explicit `target` plugin option as an override. The
// existing tests in index.spec.ts model jsdom via vm-sandbox stubs
// (window-as-empty-obj + real process). This file is the real-jsdom
// regression guard for that fidelity gap.
import { describe, expect, it } from "vitest";

import { getCollectorSnippet } from "./index.js";

describe("collector snippet under real jsdom environment", () => {
  it("Node path wins when window is jsdom and process is Node", () => {
    // jsdom defines window in this test file. Confirm.
    expect(typeof window).toBe("object");
    expect(typeof process).toBe("object");

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-jsdom-real-"));
    const prevDir = process.env.TS_CAPTURE_TYPES_DIR;
    process.env.TS_CAPTURE_TYPES_DIR = outDir;
    try {
      const snippet = getCollectorSnippet({
        literalString: false,
        literalStringMaxLength: 16,
        literalNumber: false,
        literalBoolean: false,
        captureClassHierarchy: false,
        maxAnnotationChars: 4096,
      });
      // Run the snippet in a vm context that mirrors the real jsdom
      // env: window from jsdom (passed in), process from Node (real),
      // require stubbed to mark this worker-thread context so the
      // collector flushes synchronously.
      const realRequire = require;
      const stubRequire: NodeJS.Require = ((id: string) => {
        if (id === "node:worker_threads" || id === "worker_threads") {
          return { isMainThread: false };
        }
        return realRequire(id);
      }) as NodeJS.Require;
      const ctx: Record<string, unknown> = {
        process,
        require: stubRequire,
        setInterval,
        clearInterval,
        window, // real jsdom window
        navigator: { sendBeacon: () => true },
      };
      vm.createContext(ctx);
      vm.runInContext(snippet, ctx);
      const tscptr = (ctx as { __tscptr__: (...args: unknown[]) => void }).__tscptr__;
      tscptr("v", 42, 0, "/jsdom-real.ts", "{}");

      // Node path won → dump file was written under TS_CAPTURE_TYPES_DIR.
      const dumps = fs.readdirSync(outDir).filter((f) => f.startsWith("ts-capture-types-"));
      expect(dumps.length).toBe(1);
      const contents = JSON.parse(fs.readFileSync(path.join(outDir, dumps[0]), "utf8"));
      expect(contents.length).toBe(1);
    } finally {
      if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
      else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
