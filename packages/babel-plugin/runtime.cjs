"use strict";
// CJS runtime for @ts-capture/babel-plugin. Sets globalThis.__tscptr__ so the
// __tscptr__(...) calls injected by the Babel plugin have a function to call,
// and writes collected observations to a per-PID JSON file.
//
// Usage in Jest: jest.config.js → setupFiles: ["@ts-capture/babel-plugin/runtime"]
//
// Configuration via env:
//   TS_CAPTURE_TYPES_DIR  Directory to write per-PID JSON dumps (defaults "/tmp")
//
// Why CJS: Jest setupFiles runs in a CJS context. Node 22+ supports require()
// of ESM packages, so we can require ts-capture (ESM-only) directly.

const fs = require("node:fs");
const path = require("node:path");

// Guard against re-initialization. Jest evaluates setupFiles once per test
// file (each file gets its own module registry) but globalThis is shared
// across files in the same worker process. Without this, each test file
// would replace globalThis.__tscptr__ with a closure over a fresh ctx, leaving
// observations from earlier files in orphaned ctx instances.
const RUNTIME_KEY = Symbol.for("ts-capture.babel.runtime");
if (globalThis[RUNTIME_KEY]) {
  return;
}
globalThis[RUNTIME_KEY] = true;

let createCollectionContext;
try {
  ({ createCollectionContext } = require("@ts-capture/core"));
  if (typeof createCollectionContext !== "function") {
    throw new Error("createCollectionContext not exported from ts-capture");
  }
} catch (err) {
  console.error(
    `[@ts-capture/babel-plugin/runtime] failed to load ts-capture: ${err.message}`,
  );
  return;
}

// Literal-type opt-in via env vars (Option O Phase 2):
//   TS_CAPTURE_LITERAL_STRING=true            emit short string literals as `"foo"`
//   TS_CAPTURE_LITERAL_STRING_MAX_LENGTH=24   override default 16
//   TS_CAPTURE_LITERAL_NUMBER=true            emit number literals as `42`
//   TS_CAPTURE_LITERAL_BOOLEAN=true           emit boolean literals as `true`/`false`
const literalOptions = {
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
const ctx = createCollectionContext({ literalOptions });

const TYPES_DIR = process.env.TS_CAPTURE_TYPES_DIR || "/tmp";
// Auto-create the dump directory. Without this, a TS_CAPTURE_TYPES_DIR
// pointing at a non-existent path causes every flush to throw ENOENT
// and the silent best-effort catch swallows it — 0 dumps and no signal.
try {
  fs.mkdirSync(TYPES_DIR, { recursive: true });
} catch {
  // best-effort
}
const OUT_FILE = path.join(TYPES_DIR, `ts-capture-types-${process.pid}.json`);

let lastFlushedSize = 0;
// One-shot stderr warning on write failure (BACKLOG follow-up from
// 2be6b90). Auto-mkdir covers dir-not-exists; permission-denied /
// disk-full / unmounted-volume still silently lose data without this.
let warnedWriteFailure = false;
function flush() {
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
          `[ts-capture] failed to write ${OUT_FILE}: ${e && e.message ? e.message : String(e)}\n`,
        );
      } catch {
        // best-effort
      }
    }
  }
}

// Test runners (Jest, Vitest) often pool/recycle workers in ways that don't
// reliably reach process.on("exit"). Two-pronged flushing strategy:
//   1. Eagerly write every Nth __tscptr__ call (cheap; survives hard kill)
//   2. Periodic timer + standard exit handlers (catches the long-tail
//      observations between the last call and process exit)
const FLUSH_EVERY_N_CALLS = 10;
let _callCount = 0;

function bumpAndMaybeFlush() {
  _callCount++;
  if (_callCount % FLUSH_EVERY_N_CALLS === 0) flush();
}

const __tscptr__ = function (name, value, pos, filename, optsJson) {
  ctx.record(name, value, pos, filename, JSON.parse(optsJson));
  bumpAndMaybeFlush();
};
__tscptr__.track = (v, f, o) => ctx.track(v, f, o);
__tscptr__.ret = function (value, pos, filename, optsJson) {
  ctx.record("(return)", value, pos, filename, JSON.parse(optsJson));
  bumpAndMaybeFlush();
  return value;
};
__tscptr__.registerFn = function (fn, retPos, filename) {
  ctx.registerFn(fn, retPos, filename);
};
__tscptr__.regFn = function (fn, retPos, filename) {
  ctx.registerFn(fn, retPos, filename);
  return fn;
};

globalThis.__tscptr__ = __tscptr__;

const ticker = setInterval(flush, 500);
ticker.unref();

["exit", "beforeExit", "SIGINT", "SIGTERM"].forEach((sig) => {
  process.on(sig, flush);
});
