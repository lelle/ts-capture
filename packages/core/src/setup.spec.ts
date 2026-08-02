import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-capture/core/preload's NODE_OPTIONS preload sets `__tscptr__` on Node's
// process global. Jest's `jest-environment-jsdom` wraps each test file
// in a fresh V8 vm context whose `globalThis` is the jsdom `window` —
// Node globals do not leak in. The @ts-capture/core/setup module
// is designed to be imported via `setupFilesAfterEach` so the IIFE
// runs INSIDE the sandbox and installs `__tscptr__` on the sandbox's
// globalThis.
//
// The IIFE's contract is "install `__tscptr__` on whatever `globalThis`
// is in scope when this module evaluates". A subprocess `require`
// validates that contract end-to-end without needing a real jsdom
// sandbox — Node's `globalThis` plays the same role as the sandbox's
// from the IIFE's perspective.

const SETUP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/setup.cjs");

describe("@ts-capture/core/setup", () => {
  it("installs __tscptr__ with the full instrument-time surface", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-setup-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `require(${JSON.stringify(SETUP_PATH)});
           const s = globalThis.__tscptr__;
           process.stdout.write(JSON.stringify({
             tscptr: typeof s,
             track: typeof s?.track,
             ret: typeof s?.ret,
             registerFn: typeof s?.registerFn,
           }));`,
        ],
        {
          env: { ...process.env, TS_CAPTURE_TYPES_DIR: tmpDir },
          encoding: "utf-8",
        },
      );
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toEqual({
        tscptr: "function",
        track: "function",
        ret: "function",
        registerFn: "function",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("idempotent: re-requiring in the same context does not replace __tscptr__", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-setup-"));
    try {
      // Subprocess: load setup, capture tscptr identity, bust require cache,
      // load again. If the symbol guard works, the second load is a no-op
      // and globalThis.__tscptr__ remains the same instance.
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `require(${JSON.stringify(SETUP_PATH)});
           const first = globalThis.__tscptr__;
           delete require.cache[${JSON.stringify(SETUP_PATH)}];
           require(${JSON.stringify(SETUP_PATH)});
           process.stdout.write(JSON.stringify({
             same: globalThis.__tscptr__ === first,
           }));`,
        ],
        {
          env: { ...process.env, TS_CAPTURE_TYPES_DIR: tmpDir },
          encoding: "utf-8",
        },
      );
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.same).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes a UUID-named dump file to TS_CAPTURE_TYPES_DIR when __tscptr__ is invoked", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-setup-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `require(${JSON.stringify(SETUP_PATH)});
           globalThis.__tscptr__('p', 'hello', 0, '/x.ts', '{}');
           process.exit(0);`,
        ],
        {
          env: { ...process.env, TS_CAPTURE_TYPES_DIR: tmpDir },
          encoding: "utf-8",
        },
      );
      expect(result.status).toBe(0);

      const dumps = fs
        .readdirSync(tmpDir)
        .filter((f) => /^ts-capture-types-[0-9a-f-]+\.json$/i.test(f));
      expect(dumps).toHaveLength(1);

      const content = JSON.parse(fs.readFileSync(path.join(tmpDir, dumps[0]), "utf-8"));
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
