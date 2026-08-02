import type { CollectedTypeInfo, LiteralOptions } from "@ts-capture/core";
import type { Plugin, ViteDevServer } from "vite";

import { applyTypesToFile, instrumentSource } from "@ts-capture/core";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Pluggable browser transports (v1)
// ---------------------------------------------------------------------------
//
// The default browser collector posts observations to /__ts-capture_collect
// (the dev-server middleware). For staging / sporadic-prod-debug /
// self-hosted-collector use cases, users can configure their own dispatch
// endpoints. v1 ships only `kind: "http"`; the union grows in future
// versions (sendBeacon-only, localStorage, postMessage, custom, ...).
//
// Scope: BROWSER ONLY. The Node collector path (per-PID JSON dump under
// TS_CAPTURE_TYPES_DIR) is unchanged. Node-side pluggable transport is a
// future-v2 concern with its own use-cases (S3 direct, stdout, ...).

export type TransportEvent = "periodic" | "unload";

export interface HttpTransport {
  /**
   * Which lifecycle events this transport handles. Defaults to both
   * `["periodic", "unload"]` when omitted.
   *
   * - `"periodic"` — fires on the 10-second flush via `fetch`. No
   *   payload-size limit during page lifetime.
   * - `"unload"` — fires on `beforeunload` via `navigator.sendBeacon`.
   *   Subject to sendBeacon's ~64 KB cap (last batch may be lost on
   *   pages that close mid-flush; earlier periodic flushes captured
   *   the bulk).
   */
  event?: TransportEvent[];
  kind: "http";
  url: string;
  /** Additional request headers. Baked into the bundle at build-time. */
  headers?: Record<string, string>;
}

export type BrowserTransport = HttpTransport;

interface ResolvedHttpTransport {
  event: TransportEvent[];
  kind: "http";
  url: string;
  headers?: Record<string, string>;
}

export type ResolvedTransport = ResolvedHttpTransport;

export interface TsCapturePluginOptions {
  /**
   * Regex to whitelist files for instrumentation. When set, only files
   * matching the pattern AND the built-in `.ts/.tsx/.mts/.cts` extension
   * filter are instrumented. Combine with `exclude` to subtract from the
   * whitelist. When unset, all `.ts`/`.tsx`/`.mts`/`.cts` files are
   * candidates (subject to `exclude`).
   */
  include?: RegExp;
  /** Regex to exclude files from instrumentation */
  exclude?: RegExp;
  /** Auto-apply collected types to source files (default: false) */
  apply?: boolean;
  /**
   * File to write collected types JSON (default: none).
   *
   * **Honored only in `vite serve` (dev-server / browser) mode.** Under
   * Vitest or `vite build` the plugin emits per-process JSON dumps to
   * `TS_CAPTURE_TYPES_DIR` instead — consolidate them with `ts-capture merge`.
   * Setting this option in a non-serve mode logs a warning at startup
   * and is otherwise a no-op.
   */
  outputFile?: string;
  /**
   * Opt-in literal-type emission. Baked into the
   * collector snippet at build-time, so it works in browser + Node alike.
   * Falls back to TS_CAPTURE_LITERAL_STRING / NUMBER / BOOLEAN /
   * STRING_MAX_LENGTH env vars if unset, matching
   * @ts-capture/babel-plugin/runtime.cjs.
   */
  literalOptions?: LiteralOptions;
  /**
   * Force which collector path the runtime takes. Default `undefined`
   * runs the auto-detect (`process.versions.node` first, then
   * `typeof window`). Override to `"node"` or `"browser"` when
   * auto-detect picks wrong — most commonly under Vitest with
   * `environment: "jsdom"` (jsdom defines `window` while Node's
   * `process` is still ambient; the auto-detect handles that case,
   * but `target: "node"` is the explicit form). Also useful when
   * running under Deno / Bun / future runtimes the auto-detect doesn't
   * recognise. Setting `"browser"` under Vitest is a misconfig —
   * observations sendBeacon to a middleware that isn't mounted, so
   * dumps never land. Reserved for users who know what they're doing.
   */
  target?: "node" | "browser";
  /**
   * Browser-side transport configuration. When provided, REPLACES the
   * default behavior of POSTing to `/__ts-capture_collect`. Each entry's
   * `event` field declares which lifecycle channels it handles
   * (`"periodic"`, `"unload"`, or both — defaults to both when omitted).
   *
   * Multiple transports can handle the same event for fan-out (e.g.
   * primary collector + mirror to external service). Fan-out is
   * fail-soft: one transport's error does not block the others.
   *
   * The `TS_CAPTURE_TRANSPORT_URL` env var (read at build time):
   *   - synthesizes a default transport when `transports` is omitted, or
   *   - overrides the `url` field of every `kind: "http"` entry when
   *     `transports` is present.
   *
   * Setting this option disables the default `/__ts-capture_collect`
   * pipeline — `outputFile` and `apply` will not receive observations
   * unless one of the configured transports targets that path. The
   * plugin warns at startup if that mismatch is detected.
   *
   * Note: this is BROWSER-only. Node-side observation (Vitest, etc.)
   * always goes to per-PID JSON files under `TS_CAPTURE_TYPES_DIR`.
   */
  transports?: BrowserTransport[];
}

const TS_RE = /\.(?:ts|tsx|mts|cts)$/;

/**
 * Resolves user-provided `transports` config + `TS_CAPTURE_TRANSPORT_URL`
 * env-var override into a normalized list ready for snippet emission.
 *
 * Returns `null` when:
 *   - no config and no env var → caller should use the default behavior
 *     (POST to `/__ts-capture_collect`).
 *   - `transports: []` (empty array) → falls back to default with warning.
 *
 * Exported for unit testing the resolution logic in isolation.
 */
export function resolveTransports(
  options: { transports?: BrowserTransport[] },
  envOverrideUrl: string | undefined,
): ResolvedTransport[] | null {
  const explicit = options.transports;
  if (!explicit && !envOverrideUrl) return null;
  if (explicit && explicit.length === 0) {
    console.warn(
      "[ts-capture] `transports: []` is empty — falling back to default " +
        "POST to /__ts-capture_collect. Provide at least one transport or " +
        "omit the option entirely.",
    );
    return null;
  }
  if (!explicit && envOverrideUrl) {
    return [
      {
        event: ["periodic", "unload"],
        kind: "http",
        url: envOverrideUrl,
      },
    ];
  }
  const list = explicit ?? [];
  return list.map((t) => {
    const url = envOverrideUrl ?? t.url;
    return {
      event: t.event ?? ["periodic", "unload"],
      kind: t.kind,
      url,
      ...(t.headers ? { headers: t.headers } : {}),
    };
  });
}

// "Local" URL = same-origin path or one of the loopback hostnames.
// Non-local URLs trigger a runtime console.warn at collector init to
// remind users about PII exposure risks (browser observations can
// contain form input, session tokens, etc.).
function isLocalUrl(url: string): boolean {
  if (url.startsWith("/")) return true;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)/.test(url);
}

function resolveLiteralOptions(opt?: LiteralOptions): Required<LiteralOptions> {
  return {
    literalString: opt?.literalString ?? process.env.TS_CAPTURE_LITERAL_STRING === "true",
    literalStringMaxLength:
      opt?.literalStringMaxLength ??
      (process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH
        ? Number(process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH)
        : 16),
    literalNumber: opt?.literalNumber ?? process.env.TS_CAPTURE_LITERAL_NUMBER === "true",
    literalBoolean: opt?.literalBoolean ?? process.env.TS_CAPTURE_LITERAL_BOOLEAN === "true",
    captureClassHierarchy:
      opt?.captureClassHierarchy ?? process.env.TS_CAPTURE_CAPTURE_CLASS_HIERARCHY === "true",
    maxAnnotationChars:
      opt?.maxAnnotationChars ??
      (process.env.TS_CAPTURE_MAX_ANNOTATION_CHARS
        ? Number(process.env.TS_CAPTURE_MAX_ANNOTATION_CHARS)
        : 4096),
  };
}

export function tsCapturePlugin(options: TsCapturePluginOptions = {}): Plugin {
  const literalOpts = resolveLiteralOptions(options.literalOptions);
  const resolvedTransports = resolveTransports(options, process.env.TS_CAPTURE_TRANSPORT_URL);

  return {
    name: "ts-capture",
    enforce: "pre",

    configResolved(config) {
      // outputFile is wired into configureServer (the dev-server beacon
      // sink). In vite build / Vitest there is no beacon — observations
      // go to per-process dumps under TS_CAPTURE_TYPES_DIR. Warn loudly so
      // users don't think their outputFile is being silently honored.
      if (options.outputFile && config.command !== "serve") {
        console.warn(
          "[ts-capture] outputFile is dev-server-only (vite serve). " +
            "In this mode it is ignored — per-process dumps go to TS_CAPTURE_TYPES_DIR " +
            "(default: os.tmpdir()). Run `ts-capture merge <dir> --out types.json` " +
            "to consolidate them.",
        );
      }
      // If transports redirect observations away from /__ts-capture_collect,
      // outputFile and apply (which both depend on that middleware) stop
      // receiving data. Warn so users don't think the features are
      // silently working.
      if (
        resolvedTransports &&
        (options.outputFile || options.apply) &&
        !resolvedTransports.some((t) => t.url === "/__ts-capture_collect")
      ) {
        console.warn(
          "[ts-capture] `transports` is configured but none point at " +
            "/__ts-capture_collect. `outputFile` and `apply` will not " +
            "receive observations. Add { kind: 'http', url: '/__ts-capture_collect' } " +
            "to your `transports` array to restore them.",
        );
      }
    },

    transform(code: string, id: string) {
      if (!TS_RE.test(id)) return null;
      if (options.include && !options.include.test(id)) return null;
      if (options.exclude?.test(id)) return null;

      const instrumented = instrumentSource(code, id, { skipTscptrDeclarations: true });

      // Prepend the collector snippet to EVERY instrumented file. Vitest's
      // worker model can load files in any order; relying on a "first file
      // gets the preamble" strategy breaks when a non-first file runs alone
      // in a worker. The snippet's Symbol-keyed init guard makes repeat
      // execution a cheap no-op.
      return {
        code:
          getCollectorSnippet(literalOpts, {
            target: options.target,
            transports: resolvedTransports ?? undefined,
          }) + instrumented,
        map: null,
      };
    },

    configureServer(server: ViteDevServer) {
      server.middlewares.use((req: any, res: any, next: any) => {
        if (req.url !== "/__ts-capture_collect" || req.method !== "POST") {
          return next();
        }

        let body = "";
        req.on("data", (chunk: string) => (body += chunk));
        req.on("end", () => {
          try {
            const typeInfo = JSON.parse(body) as CollectedTypeInfo;

            if (options.outputFile) {
              fs.writeFileSync(options.outputFile, JSON.stringify(typeInfo, null, 2));
            }

            if (options.apply) {
              const grouped = new Map<string, CollectedTypeInfo>();
              for (const entry of typeInfo) {
                const file = entry[0];
                const existing = grouped.get(file);
                if (existing) existing.push(entry);
                else grouped.set(file, [entry]);
              }
              for (const [file, entries] of grouped) {
                try {
                  const source = fs.readFileSync(file, "utf-8");
                  fs.writeFileSync(file, applyTypesToFile(source, entries, {}));
                } catch {}
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
          }
        });
      });
    },
  };
}

// Exported for testing the collector snippet's runtime behavior in
// isolation (e.g. the Proxy-recursion regression test).
export function getCollectorSnippet(
  literalOpts: Required<LiteralOptions>,
  envOpts: {
    target?: "node" | "browser";
    transports?: ResolvedTransport[];
  } = {},
): string {
  const transports = envOpts.transports;
  const periodicTransports = transports
    ? transports.filter((t) => t.event.includes("periodic"))
    : null;
  const unloadTransports = transports ? transports.filter((t) => t.event.includes("unload")) : null;
  const nonLocalUrls = transports
    ? Array.from(new Set(transports.filter((t) => !isLocalUrl(t.url)).map((t) => t.url)))
    : [];

  const emitHttpFetch = (list: ResolvedTransport[] | null): string => {
    if (list === null) {
      return `try { fetch("/__ts-capture_collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: body }).catch(function() {}); } catch (e) {}`;
    }
    return list
      .map((t) => {
        const headers = {
          "Content-Type": "application/json",
          ...t.headers,
        };
        return `try { fetch(${JSON.stringify(t.url)}, { method: "POST", headers: ${JSON.stringify(headers)}, body: body }).catch(function() {}); } catch (e) {}`;
      })
      .join("\n      ");
  };
  const emitBeaconCalls = (list: ResolvedTransport[] | null): string => {
    if (list === null) {
      return `navigator.sendBeacon("/__ts-capture_collect", body);`;
    }
    return list
      .map((t) => `try { navigator.sendBeacon(${JSON.stringify(t.url)}, body); } catch (e) {}`)
      .join("\n      ");
  };
  const privacyWarning =
    nonLocalUrls.length > 0
      ? `if (typeof console !== "undefined" && console.warn) { console.warn("[ts-capture] sending observations to non-local URL(s): " + ${JSON.stringify(nonLocalUrls.join(", "))} + ". Observation payloads can contain PII (form input, session data, API responses). Verify user consent and configure redaction before enabling in production."); }`
      : "";
  // Universal __tscptr__ collector for both browser (Vite dev server) and
  // Node (Vitest). Sets up globalThis.__tscptr__ with the full instrument-time
  // surface (__tscptr__, .ret, .track, .registerFn) and reports observations
  // either via navigator.sendBeacon (browser) or per-PID JSON dump (Node).
  //
  // Symbol-keyed init guard so vitest's per-test-file module re-eval
  // doesn't replace globalThis.__tscptr__ mid-run with a closure over a fresh
  // log map (orphaning earlier observations — same trap we hit in
  // @ts-capture/babel-plugin/runtime.cjs).
  //
  // Literal-type opt-in: values baked in at build-time
  // from plugin options (or env-var fallback) so the same flags work in
  // both browser and Node — process.env isn't available in the browser.
  return `
(function() {
  var __TSCPTR_KEY = Symbol.for("ts-capture.vite.runtime");
  if (globalThis[__TSCPTR_KEY]) return;
  globalThis[__TSCPTR_KEY] = true;

  var LITERAL_STRING = ${literalOpts.literalString};
  var LITERAL_STRING_MAX = ${literalOpts.literalStringMaxLength};
  var LITERAL_NUMBER = ${literalOpts.literalNumber};
  var LITERAL_BOOLEAN = ${literalOpts.literalBoolean};
  var CAPTURE_CLASS_HIERARCHY = ${literalOpts.captureClassHierarchy};

  var __tscptr__logs = {};

  // Re-entry guard. Without this, observing a Proxy-backed value (Hono's
  // c.req.queries, Vue's reactive(), Solid signals, etc.) triggers a
  // recursion bomb: getTypeName walks value[k], the Proxy.get handler is
  // itself instrumented and calls __tscptr__ with the value it returns,
  // __tscptr__ calls getTypeName, which walks the new value, hitting
  // Proxy.get again — until V8 throws RangeError. Setting this flag
  // around the record path makes nested __tscptr__ calls a no-op so the
  // Proxy's own get handler runs cleanly without re-entering the
  // collector.
  var __tscptr__in_record = false;

  function __tscptr__getTypeName(value, depth, maxDepth, visited) {
    if (depth === undefined) { depth = 0; maxDepth = 5; visited = new Set(); }
    if (depth >= maxDepth) return null;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    // ts-capture.peek protocol: a value can opt into safe inspection by
    // attaching a function under Symbol.for("ts-capture.peek"). When set,
    // ts-capture walks the function's return value instead of the proxy
    // facade. This is how framework adapters (Vue, MobX, Solid, etc.)
    // expose unwrapped state without us having to know about each
    // library's internal sigils. Library-specific knowledge belongs
    // OUTSIDE core — see ROADMAP "Plugin model" for the rationale.
    if (typeof value === "object" || typeof value === "function") {
      try {
        var peek = value[Symbol.for("ts-capture.peek")];
        if (typeof peek === "function") value = peek.call(value);
      } catch (e) { /* peek threw — fall through to walking the original value */ }
    }
    var t = typeof value;
    if (t === "string" && LITERAL_STRING && value.length <= LITERAL_STRING_MAX) return JSON.stringify(value);
    if (t === "number" && LITERAL_NUMBER && Number.isFinite(value)) return String(value);
    if (t === "boolean" && LITERAL_BOOLEAN) return String(value);
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint" || t === "symbol") return t;
    if (typeof value === "object" || typeof value === "function") {
      if (visited.has(value)) return null;
      visited.add(value);
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return "unknown[]";
      var types = new Set();
      for (var i = 0; i < value.length; i++) {
        var n = __tscptr__getTypeName(value[i], depth + 1, maxDepth, visited);
        if (n !== null) types.add(n);
      }
      if (types.size === 0) return "unknown[]";
      var arr = Array.from(types).sort();
      return arr.length === 1 ? arr[0] + "[]" : "Array<" + arr.join("|") + ">";
    }
    if (typeof value === "function") {
      try {
        var source = value.toString();
        // Native functions: \`function name() { [native code] }\`. Bound
        // functions expose a positional fallback signature.
        if (source.indexOf("[native code]") !== -1) {
          if (value.name && value.name.indexOf("bound ") === 0) return "(...args: unknown[]) => unknown";
          return "Function";
        }
        // Class constructors: \`class Foo { ... }\` → \`typeof Foo\`.
        if (source.indexOf("class ") === 0) {
          return "typeof " + (value.name || "anonymous");
        }
        var isAsync = source.indexOf("async ") === 0;
        // "async function*" contains "function*", so one check covers both.
        var isGenerator = source.indexOf("function*") !== -1;
        var s = source.split("=>")[0];
        s = s.indexOf("(") !== -1 ? (s.match(/\\(.*?\\)/g) || ["()"])[0] : "(" + s + ")";
        // Depth-tracking arg split: a naive .split(",") breaks destructured
        // params like ({a, b}) into ["{a", " b}"]. Mirror of
        // type-signature.ts:resolveFunctionType depth scan.
        var inner = s.replace(/^\\(|\\)$/g, "");
        var args = [];
        var depth_ = 0;
        var current = "";
        for (var ci = 0; ci < inner.length; ci++) {
          var ch = inner.charAt(ci);
          if (ch === "{" || ch === "[" || ch === "(") depth_++;
          else if (ch === "}" || ch === "]" || ch === ")") depth_--;
          if (ch === "," && depth_ === 0) {
            if (current.trim() !== "") args.push(current);
            current = "";
          } else {
            current += ch;
          }
        }
        if (current.trim() !== "") args.push(current);
        var VALID_IDENT = /^[a-zA-Z_$][\\w$]*$/;
        var typed = args.map(function(a, idx) {
          var name = a.split("=")[0].trim();
          // Defense against mangled toString that yields a CALL expression
          // as the first paren group (jsdom synthetic globals etc.) — bare
          // numerics and quoted strings are valid call args but invalid TS
          // parameter names. Mirror of type-signature.ts:resolveFunctionType.
          var isShapelike =
            name.charAt(0) === "[" || name.charAt(0) === "{" ||
            name.indexOf("...") === 0 || VALID_IDENT.test(name);
          if (!isShapelike) return "arg" + idx + ": unknown";
          // Destructured array param: multi-field uses a positional name
          // (arg{idx}Array); a single valid binding keeps its name (aArray).
          if (name.indexOf("[") !== -1) {
            var arrFields = name.replace(/[\\[\\]]/g, "").split(",").map(function(f) {
              return f.trim();
            }).filter(function(f) { return f !== ""; });
            var arrConcat = (arrFields.length === 1 && VALID_IDENT.test(arrFields[0])) ? arrFields[0] : "arg" + idx;
            return arrConcat + "Array: unknown";
          }
          // Destructured object param: multi-field uses a positional name
          // (arg{idx}Object); object-rest adds an index signature; rename
          // {prop: local} uses the local binding name.
          if (name.indexOf("{") !== -1) {
            var objFields = name.replace(/[{}]/g, "").split(",").map(function(f) {
              return f.trim();
            }).filter(function(f) { return f !== ""; });
            var namedF = objFields.filter(function(f) { return f.indexOf("...") !== 0; });
            var hasRest = objFields.some(function(f) { return f.indexOf("...") === 0; });
            var localNames = namedF.map(function(f) {
              var colon = f.indexOf(":");
              return colon >= 0 ? f.slice(colon + 1).trim() : f;
            });
            var objName = (localNames.length === 1 && !hasRest && VALID_IDENT.test(localNames[0])) ? localNames[0] : "arg" + idx;
            var innerParts = localNames.map(function(f) { return f + ": unknown"; });
            if (hasRest) innerParts.push("[k: string]: unknown");
            return objName + "Object: {" + innerParts.join(", ") + "}";
          }
          if (name.indexOf("...") === 0) return name + "Array: unknown[]";
          return name + ": unknown";
        });
        var returnType = "unknown";
        if (isAsync && isGenerator) returnType = "AsyncGenerator<unknown>";
        else if (isGenerator) returnType = "Generator<unknown>";
        else if (isAsync) returnType = "Promise<unknown>";
        return "(" + typed.join(", ") + ") => " + returnType;
      } catch(e) { return "Function"; }
    }
    if (typeof value === "object") {
      var ctor = value.constructor && value.constructor.name;
      if (ctor && ctor !== "Object") {
        if (CAPTURE_CLASS_HIERARCHY) {
          // Walk prototype chain (excluding the value's own ctor and
          // Object.prototype), collect ancestor names. Mirror of
          // type-collector.ts:getInheritanceChain. Encoded inline in
          // the type name so apply-time merge can detect the chain
          // without a wire-format change.
          var chain = [];
          var seenProtos = new Set();
          var p = Object.getPrototypeOf(value);
          if (p) p = Object.getPrototypeOf(p);
          while (p && p !== Object.prototype) {
            if (seenProtos.has(p)) break;
            seenProtos.add(p);
            var n = p.constructor && p.constructor.name;
            if (n && n !== "Object") chain.push(n);
            p = Object.getPrototypeOf(p);
          }
          return ctor + " /* @sa:" + chain.join("|") + " */";
        }
        return ctor;
      }
      // Skip ts-capture-internal keys (__tscptr__, __tscptr__*) attached to
      // globalThis by the runtime collector — they pollute observed
      // types when user code casts globalThis (window-as-cast under
      // jsdom). Mirror of type-collector.ts:TS_CAPTURE_INTERNAL_KEY.
      var TS_CAPTURE_INTERNAL_KEY = /^__tscptr__/;
      var keys = Object.keys(value).filter(function(k) {
        return !TS_CAPTURE_INTERNAL_KEY.test(k);
      }).sort();
      if (keys.length === 0) return "{}";
      var pairs = keys.map(function(k) {
        var ek = /^[a-z_$][a-z0-9_$]*$/i.test(k) ? k : JSON.stringify(k);
        var vt = __tscptr__getTypeName(value[k], depth + 1, maxDepth, visited);
        return ek + ": " + (vt || "unknown");
      });
      return "{ " + pairs.join(", ") + " }";
    }
    return t;
  }

  function __tscptr__record(name, value, pos, filename, optsJson) {
    if (__tscptr__in_record) return; // re-entry guard, see __tscptr__in_record decl
    __tscptr__in_record = true;
    try {
      var key = JSON.stringify({ filename: filename, pos: pos, opts: JSON.parse(optsJson) });
      if (!__tscptr__logs[key]) __tscptr__logs[key] = new Set();
      var typeName;
      try { typeName = __tscptr__getTypeName(value); }
      catch (e) { typeName = "unknown"; } // belt-and-suspenders for any other walk failures
      __tscptr__logs[key].add(JSON.stringify([typeName, undefined]));
    } finally {
      __tscptr__in_record = false;
    }
  }

  var __tscptr__ = function(name, value, pos, filename, optsJson) {
    __tscptr__record(name, value, pos, filename, optsJson);
    __tscptr__bump();
  };
  __tscptr__.track = function(value, filename, offset) { return value; };
  __tscptr__.ret = function(value, pos, filename, optsJson) {
    __tscptr__record("(return)", value, pos, filename, optsJson);
    __tscptr__bump();
    return value;
  };
  __tscptr__.registerFn = function(fn, retPos, filename) { /* no-op in this runtime */ };
  __tscptr__.regFn = function(fn, retPos, filename) { /* no-op in this runtime */ return fn; };
  __tscptr__.get = function() {
    return Object.keys(__tscptr__logs).map(function(key) {
      var parsed = JSON.parse(key);
      var types = Array.from(__tscptr__logs[key]).map(function(v) { return JSON.parse(v); });
      return [parsed.filename, parsed.pos, types, parsed.opts];
    });
  };
  globalThis.__tscptr__ = __tscptr__;

  // --- Reporting: branch on environment ---
  // Auto-detect order matters: under Vitest with environment "jsdom"
  // (SvelteKit / RTL / Vue defaults), BOTH window and process are
  // defined — jsdom adds window without removing Node globals. With
  // IS_BROWSER checked first, the beacon path wins and observations
  // go to a middleware that isn't mounted under vitest-run. Check
  // IS_NODE first; IS_BROWSER only when not Node. The plugin's target
  // option (baked in here at build-time) is the explicit override for
  // runtimes the auto-detect doesn't recognise.
  var __tscptr__target = ${JSON.stringify(envOpts.target ?? "auto")};
  var __tscptr__has_node = typeof process !== "undefined" && process.versions != null && process.versions.node != null;
  var __tscptr__has_window = typeof window !== "undefined";
  var IS_NODE = __tscptr__target === "node" || (__tscptr__target === "auto" && __tscptr__has_node);
  var IS_BROWSER = __tscptr__target === "browser" || (__tscptr__target === "auto" && !IS_NODE && __tscptr__has_window);

  if (IS_BROWSER) {
    // Two-channel reporting:
    //   - Periodic flush uses fetch (no keepalive). Both sendBeacon and
    //     fetch+keepalive cap at ~64 KB per origin per page lifetime and
    //     silently drop larger payloads — that's smaller than the
    //     observation array for any non-trivial SPA within seconds of
    //     instrumentation. Plain fetch has no size limit while the page
    //     is alive.
    //   - Unload flush uses sendBeacon because the page is dying and
    //     plain fetch may not complete. sendBeacon's 64 KB cap is
    //     accepted here as a best-effort final-batch loss; earlier
    //     periodic flushes already captured the bulk.
    //
    // When 'transports' is configured, the calls below fan out to each
    // entry registered for the corresponding channel. Each call is
    // wrapped in try/catch so one transport's error does not block the
    // others.
    ${privacyWarning}
    var __tscptr__report_periodic = function() {
      var types = __tscptr__.get();
      if (types.length === 0) return;
      var body = JSON.stringify(types);
      ${emitHttpFetch(periodicTransports)}
    };
    var __tscptr__report_unload = function() {
      var types = __tscptr__.get();
      if (types.length === 0) return;
      var body = JSON.stringify(types);
      ${emitBeaconCalls(unloadTransports)}
    };
    window.addEventListener("beforeunload", __tscptr__report_unload);
    setInterval(__tscptr__report_periodic, 10000);
    __tscptr__bump = function() {};
  } else if (IS_NODE) {
    // Per-PID JSON dump under TS_CAPTURE_TYPES_DIR (defaults to os.tmpdir()).
    // Vitest workers don't reliably reach process.on("exit"), so we flush
    // every Nth observation in addition to standard exit handlers — same
    // pattern proven in @ts-capture/babel-plugin/runtime.cjs.
    var fs = require("node:fs");
    var path = require("node:path");
    var os = require("node:os");
    var crypto = require("node:crypto");
    var TYPES_DIR = process.env.TS_CAPTURE_TYPES_DIR || os.tmpdir();
    // Auto-create the dump directory. Without this, a TS_CAPTURE_TYPES_DIR
    // pointing at a non-existent path causes every flush to throw ENOENT
    // and the silent best-effort catch below swallows it — 0 dumps, no
    // warning, identical-looking failure to the just-fixed jsdom branch
    // bug. mkdirSync with recursive:true is idempotent across worker
    // forks (no-op on existing dirs).
    try { fs.mkdirSync(TYPES_DIR, { recursive: true }); } catch (e) { /* best-effort */ }
    // UUID, not PID. Vitest worker_threads share the parent's PID, so
    // a PID-keyed filename collides between threads and the last writer
    // wins (silent data loss). nyc switched to UUIDs for the same
    // reason.
    var OUT_FILE = path.join(
      TYPES_DIR,
      "ts-capture-types-" + crypto.randomUUID() + ".json"
    );
    // Vitest workers exit before the 500ms ticker fires AND
    // process.on("exit") doesn't reliably fire in worker_threads, so
    // a short worker would emit 0 dumps with the main-thread default
    // (FLUSH_EVERY=10). Detecting worker_threads context lets us flush
    // every observation there while keeping the lower-overhead default
    // for main-thread / forks-pool runs.
    var IS_WORKER_THREAD = false;
    try {
      var __tscptr__wt = require("node:worker_threads");
      IS_WORKER_THREAD = __tscptr__wt.isMainThread === false;
    } catch (e) { /* worker_threads unavailable; assume main */ }
    var lastFlushed = 0;
    var FLUSH_EVERY = IS_WORKER_THREAD ? 1 : 10;
    var callCount = 0;
    // One-shot stderr warning on write failure (follow-up from
    // 2be6b90). Auto-mkdir covers dir-not-exists; permission-denied /
    // disk-full / unmounted-volume still silently lose data without
    // this. Guarded so repeat flushes don't spam.
    var __tscptr__warned = false;
    function __tscptr__flush() {
      var types = __tscptr__.get();
      if (types.length === lastFlushed) return;
      lastFlushed = types.length;
      try {
        fs.writeFileSync(OUT_FILE, JSON.stringify(types));
      } catch (e) {
        if (!__tscptr__warned) {
          __tscptr__warned = true;
          try { process.stderr.write("[ts-capture] failed to write " + OUT_FILE + ": " + (e && e.message ? e.message : String(e)) + "\\n"); } catch (e2) { /* best-effort */ }
        }
      }
    }
    __tscptr__bump = function() {
      callCount++;
      if (callCount % FLUSH_EVERY === 0) __tscptr__flush();
    };
    var ticker = setInterval(__tscptr__flush, 500);
    if (ticker.unref) ticker.unref();
    ["exit", "beforeExit", "SIGINT", "SIGTERM"].forEach(function(sig) {
      process.on(sig, __tscptr__flush);
    });
  } else {
    __tscptr__bump = function() {};
  }

  function __tscptr__bump() {}
})();
`;
}

export default tsCapturePlugin;
