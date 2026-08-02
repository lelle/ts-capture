// Shared installer for ts-capture's runtime entry points: the Node CJS
// preload (`./preload`, loaded via `NODE_OPTIONS='--require
// @ts-capture/core/preload'`) and the Jest-compatible setupFile
// (`./setup`, loaded via `setupFilesAfterEnv`). Both install the same
// `globalThis.__tscptr__` instrument-time surface, write per-context
// UUID-named JSON dumps, and flush on a ticker + process teardown.
//
// Configuration via env (all optional):
//   TS_CAPTURE_TYPES_DIR              Directory for per-context JSON dumps
//                                     (default: os.tmpdir())
//   TS_CAPTURE_LITERAL_STRING=true    Emit short string literals as types
//   TS_CAPTURE_LITERAL_STRING_MAX_LENGTH=N   Override default 16
//   TS_CAPTURE_LITERAL_NUMBER=true    Emit number literals
//   TS_CAPTURE_LITERAL_BOOLEAN=true   Emit boolean literals
//   TS_CAPTURE_MAX_ANNOTATION_CHARS=N Cap serialized type size (default 4096)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtraOptions, LiteralOptions } from "./collector-contract.js";

import { createCollectionContext } from "./collection-context.js";

interface TscptrFn {
  (name: string, value: unknown, pos: number, filename: string, optsJson: string): void;
  track<T>(value: T, filename: string, offset: number): T;
  ret<T>(value: T, pos: number, filename: string, optsJson: string): T;
  registerFn(fn: Function, retPos: number, filename: string): void;
  regFn<F extends Function>(fn: F, retPos: number, filename: string): F;
}

// Shared across every context that loads either entry point in the same
// process — a Node preload (one context) plus N jsdom sandboxes (each a
// separate context loading `./setup`). The guard keeps the first-installed
// ctx authoritative so later loads don't orphan earlier observations.
const SETUP_KEY = Symbol.for("ts-capture.runtime.setup");

function resolveLiteralOptions(): LiteralOptions {
  return {
    literalString: process.env.TS_CAPTURE_LITERAL_STRING === "true",
    literalStringMaxLength: process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH
      ? Number(process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH)
      : undefined,
    literalNumber: process.env.TS_CAPTURE_LITERAL_NUMBER === "true",
    literalBoolean: process.env.TS_CAPTURE_LITERAL_BOOLEAN === "true",
    maxAnnotationChars: process.env.TS_CAPTURE_MAX_ANNOTATION_CHARS
      ? Number(process.env.TS_CAPTURE_MAX_ANNOTATION_CHARS)
      : undefined,
  };
}

export function installTsCaptureRuntime(): void {
  const guarded = globalThis as typeof globalThis & {
    [SETUP_KEY]?: boolean;
    __tscptr__?: TscptrFn;
  };
  if (guarded[SETUP_KEY]) return;
  guarded[SETUP_KEY] = true;

  const ctx = createCollectionContext({ literalOptions: resolveLiteralOptions() });

  const TYPES_DIR = process.env.TS_CAPTURE_TYPES_DIR || os.tmpdir();
  // Auto-create the dump directory. Without this, a TS_CAPTURE_TYPES_DIR
  // pointing at a non-existent path causes every flush to throw ENOENT and
  // the silent best-effort catch swallows it — 0 dumps and no signal.
  try {
    fs.mkdirSync(TYPES_DIR, { recursive: true });
  } catch {
    // best-effort
  }
  // UUID, not PID. Vitest worker_threads share the parent's PID, so
  // PID-keyed dump filenames collide and the last writer wins. A single
  // process may also host the preload (one context) + N jsdom sandboxes
  // (each loading `./setup`) — UUID always disambiguates.
  const OUT_FILE = path.join(TYPES_DIR, `ts-capture-types-${crypto.randomUUID()}.json`);

  const tscptr = function (
    name: string,
    value: unknown,
    pos: number,
    filename: string,
    optsJson: string,
  ): void {
    ctx.record(name, value, pos, filename, JSON.parse(optsJson) as ExtraOptions);
  } as TscptrFn;
  tscptr.track = (v, f, o) => ctx.track(v, f, o);
  tscptr.ret = function (value, pos, filename, optsJson) {
    ctx.record("(return)", value, pos, filename, JSON.parse(optsJson) as ExtraOptions);
    return value;
  };
  tscptr.registerFn = function (fn, retPos, filename) {
    ctx.registerFn(fn, retPos, filename);
  };
  tscptr.regFn = function (fn, retPos, filename) {
    ctx.registerFn(fn, retPos, filename);
    return fn;
  };

  guarded.__tscptr__ = tscptr;

  let lastFlushedSize = 0;
  // One-shot stderr warning on write failure. Auto-mkdir covers
  // dir-not-exists; permission-denied / disk-full / unmounted-volume still
  // silently lose data without this.
  let warnedWriteFailure = false;
  function flush(): void {
    const types = ctx.getCollectedTypes();
    if (types.length === lastFlushedSize) return;
    lastFlushedSize = types.length;
    try {
      fs.writeFileSync(OUT_FILE, JSON.stringify(types));
    } catch (e) {
      if (!warnedWriteFailure) {
        warnedWriteFailure = true;
        try {
          process.stderr.write(
            `[ts-capture] failed to write ${OUT_FILE}: ${e && (e as Error).message ? (e as Error).message : String(e)}\n`,
          );
        } catch {
          // best-effort
        }
      }
    }
  }

  const ticker = setInterval(flush, 500);
  // `.unref()` is Node-specific (Timer object). Inside jsdom, setInterval
  // returns a numeric id with no .unref() — guard the call so a jsdom
  // sandbox doesn't crash on load. The process.on teardown hooks below
  // cover flush either way.
  if (ticker && typeof ticker.unref === "function") {
    ticker.unref();
  }

  // Attach to the Node process — works even from a jsdom sandbox because
  // `process` is a Node global the sandbox inherits (jest-environment-jsdom
  // copies process across).
  (["exit", "beforeExit", "SIGINT", "SIGTERM"] as const).forEach((sig) => {
    process.on(sig, flush);
  });
}
