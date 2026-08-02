import ts from "typescript";

/**
 * The position recorded with each __tscptr__ call. Byte offset into the
 * ORIGINAL (un-instrumented) bundle source — that's what the source map
 * was built against, so positions remain valid for source-map round-trips
 * even after we shift bytes by inserting tracking calls.
 */
export interface BundleObservation {
  name: string; // parameter / variable name from the bundle (may be mangled)
  pos: number; // byte offset of the identifier name in the original bundle
  file: string; // bundle file path
  type: string; // observed runtime type-name
}

export interface InstrumentBundleOptions {
  /**
   * Path that runtime __tscptr__ calls record as `file`. Defaults to the
   * second argument of `instrumentBundle`. Override if the bundle will
   * be moved before running (so the runtime still records a path your
   * source-map references).
   */
  bundlePath?: string;
}

export interface InstrumentBundleResult {
  /** Instrumented JS source. Includes the runtime preamble. */
  code: string;
  /** Number of function bodies instrumented. */
  instrumentedCount: number;
}

/**
 * Parse a bundled JavaScript file, inject `__tscptr__(name, value, pos, file)`
 * calls at the start of every function body for every parameter, and
 * prepend an inline runtime that collects observations and dumps them to
 * a per-PID JSON file on process exit.
 *
 * Importantly, the `pos` recorded in each instrumented call is the byte
 * offset of the parameter name in the ORIGINAL bundle (before our own
 * insertions shift bytes). This means the recorded positions survive
 * round-trip through the bundle's source map without any chained-map
 * arithmetic — the source map maps original-bundle bytes to source bytes,
 * and that's exactly the coordinate system our observations live in.
 */
export function instrumentBundle(
  bundleSource: string,
  bundleFsPath: string,
  options: InstrumentBundleOptions = {},
): InstrumentBundleResult {
  const recordedPath = options.bundlePath ?? bundleFsPath;
  const sf = ts.createSourceFile(
    bundleFsPath,
    bundleSource,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );

  const insertions: Array<[number, string]> = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node)) &&
      node.body &&
      ts.isBlock(node.body) &&
      node.parameters.length > 0
    ) {
      const bodyStart = node.body.getStart() + 1;
      const calls = node.parameters
        .map((p) => {
          if (!ts.isIdentifier(p.name)) return "";
          const name = p.name.text;
          const namePos = p.name.getStart();
          // The if-guard prevents reference errors if the runtime
          // preamble was somehow stripped.
          return `if(globalThis.__tscptr__)globalThis.__tscptr__(${JSON.stringify(name)},${name},${namePos},${JSON.stringify(recordedPath)});`;
        })
        .filter((s) => s.length > 0)
        .join("");
      if (calls.length > 0) insertions.push([bodyStart, calls]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  // Apply back-to-front so earlier offsets remain valid.
  insertions.sort((a, b) => b[0] - a[0]);
  let out = bundleSource;
  for (const [pos, code] of insertions) {
    out = out.slice(0, pos) + code + out.slice(pos);
  }

  return {
    code: BUNDLE_RUNTIME_PREAMBLE + out,
    instrumentedCount: insertions.length,
  };
}

/**
 * Inline runtime prepended to every instrumented bundle. CJS for maximum
 * compatibility with anything Node can run. Symbol-keyed init guard so
 * if the bundle is loaded multiple times in the same process (e.g. via
 * a test runner that re-requires modules) we don't replace globalThis.
 *
 * Per-PID JSON dump under TS_CAPTURE_TYPES_DIR (defaults to os.tmpdir()) on
 * process exit + every 10 observations + 500 ms ticker — same pattern
 * proven in @ts-capture/babel-plugin/runtime.cjs.
 *
 * Literal-type opt-in via env vars (same surface as
 * @ts-capture/babel-plugin/runtime.cjs):
 *   TS_CAPTURE_LITERAL_STRING=true            emit short string literals
 *   TS_CAPTURE_LITERAL_STRING_MAX_LENGTH=24   override default 16
 *   TS_CAPTURE_LITERAL_NUMBER=true            emit number literals
 *   TS_CAPTURE_LITERAL_BOOLEAN=true           emit boolean literals
 */
const BUNDLE_RUNTIME_PREAMBLE = `
(function () {
  var KEY = Symbol.for("ts-capture.bundle.runtime");
  if (globalThis[KEY]) return;
  globalThis[KEY] = true;
  var fs = require("node:fs");
  var path = require("node:path");
  var os = require("node:os");
  var TYPES_DIR = process.env.TS_CAPTURE_TYPES_DIR || os.tmpdir();
  var OUT_FILE = path.join(TYPES_DIR, "ts-capture-bundle-types-" + process.pid + ".json");
  var LITERAL_STRING = process.env.TS_CAPTURE_LITERAL_STRING === "true";
  var LITERAL_STRING_MAX = process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH ? Number(process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH) : 16;
  var LITERAL_NUMBER = process.env.TS_CAPTURE_LITERAL_NUMBER === "true";
  var LITERAL_BOOLEAN = process.env.TS_CAPTURE_LITERAL_BOOLEAN === "true";
  var observations = [];
  var lastFlushed = 0;
  function getType(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) return "array";
    var t = typeof value;
    if (t === "string" && LITERAL_STRING && value.length <= LITERAL_STRING_MAX) return JSON.stringify(value);
    if (t === "number" && LITERAL_NUMBER && Number.isFinite(value)) return String(value);
    if (t === "boolean" && LITERAL_BOOLEAN) return String(value);
    if (t === "object") {
      var ctor = value.constructor && value.constructor.name;
      return ctor && ctor !== "Object" ? ctor : "object";
    }
    return t;
  }
  function flush() {
    if (observations.length === lastFlushed) return;
    lastFlushed = observations.length;
    try { fs.writeFileSync(OUT_FILE, JSON.stringify(observations)); } catch (e) {}
  }
  globalThis.__tscptr__ = function (name, value, pos, file) {
    observations.push({ name: name, pos: pos, file: file, type: getType(value) });
    if (observations.length % 10 === 0) flush();
  };
  var ticker = setInterval(flush, 500);
  if (ticker.unref) ticker.unref();
  ["exit", "beforeExit", "SIGINT", "SIGTERM"].forEach(function (sig) {
    process.on(sig, flush);
  });
})();
`;
