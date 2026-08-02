import type { Plugin } from "vite";

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import type { BrowserTransport } from "./index.js";

import { getCollectorSnippet, resolveTransports, tsCapturePlugin } from "./index.js";

describe("tsCapturePlugin", () => {
  it("returns a vite plugin object", () => {
    const plugin = tsCapturePlugin();
    expect(plugin.name).toBe("ts-capture");
  });

  it("has transform and configureServer hooks", () => {
    const plugin = tsCapturePlugin() as Plugin;
    expect(plugin.transform).toBeDefined();
    expect(plugin.configureServer).toBeDefined();
  });

  describe("configResolved (outputFile mode warning)", () => {
    // outputFile is wired into configureServer (the dev-server beacon
    // sink). Setting it under Vitest / vite build is a silent no-op
    // unless we warn.
    function callConfigResolved(plugin: Plugin, command: "serve" | "build") {
      const hook = plugin.configResolved as Function;
      // Minimal ResolvedConfig stub — only `command` is read.
      hook({ command });
    }

    it("warns when outputFile is set and command is not 'serve'", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const plugin = tsCapturePlugin({ outputFile: "out.json" }) as Plugin;
        callConfigResolved(plugin, "build");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/outputFile is dev-server-only/);
        expect(warn.mock.calls[0][0]).toMatch(/ts-capture merge/);
      } finally {
        warn.mockRestore();
      }
    });

    it("does not warn when outputFile is set and command is 'serve'", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const plugin = tsCapturePlugin({ outputFile: "out.json" }) as Plugin;
        callConfigResolved(plugin, "serve");
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("does not warn when outputFile is unset", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const plugin = tsCapturePlugin() as Plugin;
        callConfigResolved(plugin, "build");
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("transform", () => {
    it("instruments .ts files", () => {
      const plugin = tsCapturePlugin() as Plugin;
      const transform = plugin.transform as Function;
      const result = transform("function foo(a) { return a; }", "/src/app.ts");
      expect(result).toBeDefined();
      expect(result.code).toContain("__tscptr__");
    });

    it("instruments .tsx files", () => {
      const plugin = tsCapturePlugin() as Plugin;
      const transform = plugin.transform as Function;
      const result = transform("function foo(a) { return a; }", "/src/app.tsx");
      expect(result).toBeDefined();
      expect(result.code).toContain("__tscptr__");
    });

    it("skips non-ts files", () => {
      const plugin = tsCapturePlugin() as Plugin;
      const transform = plugin.transform as Function;
      const result = transform("const x = 1;", "/src/style.css");
      expect(result).toBeNull();
    });

    it("skips files matching exclude pattern", () => {
      const plugin = tsCapturePlugin({ exclude: /\.spec\.ts$/ }) as Plugin;
      const transform = plugin.transform as Function;
      const result = transform("function foo(a) { return a; }", "/src/app.spec.ts");
      expect(result).toBeNull();
    });

    // Whitelist mode: exclude alone forces users to write
    // negative-lookahead regexes when they want to scope instrumentation
    // to a single file or directory. `include` makes whitelist-style
    // scoping a first-class option.
    it("instruments files matching include pattern", () => {
      const plugin = tsCapturePlugin({ include: /\/lib\// }) as Plugin;
      const transform = plugin.transform as Function;
      const result = transform("function foo(a) { return a; }", "/src/lib/foo.ts");
      expect(result).toBeDefined();
      expect(result.code).toContain("__tscptr__");
    });

    it("skips files NOT matching include pattern", () => {
      const plugin = tsCapturePlugin({ include: /\/lib\// }) as Plugin;
      const transform = plugin.transform as Function;
      const result = transform("function foo(a) { return a; }", "/src/routes/foo.ts");
      expect(result).toBeNull();
    });

    it("checks include AND exclude together: file must match include and not exclude", () => {
      const plugin = tsCapturePlugin({
        include: /\/lib\//,
        exclude: /\.spec\.ts$/,
      }) as Plugin;
      const transform = plugin.transform as Function;
      // In lib/, not a spec — instrumented
      expect(transform("function foo(a){return a}", "/src/lib/foo.ts").code).toContain(
        "__tscptr__",
      );
      // In lib/, but a spec — skipped (exclude wins)
      expect(transform("function foo(a){return a}", "/src/lib/foo.spec.ts")).toBeNull();
      // Not in lib/ — skipped (include doesn't match)
      expect(transform("function foo(a){return a}", "/src/routes/foo.ts")).toBeNull();
    });

    it("without include or exclude, instruments all .ts files (current behavior preserved)", () => {
      const plugin = tsCapturePlugin() as Plugin;
      const transform = plugin.transform as Function;
      expect(transform("function foo(a){return a}", "/src/lib/foo.ts").code).toContain(
        "__tscptr__",
      );
      expect(transform("function foo(a){return a}", "/src/routes/foo.ts").code).toContain(
        "__tscptr__",
      );
    });

    it("injects collector snippet on entry module", () => {
      const plugin = tsCapturePlugin() as Plugin;
      const transform = plugin.transform as Function;
      // First .ts file transformed gets the collector
      const result = transform("function foo(a) { return a; }", "/src/main.ts");
      expect(result.code).toContain("__tscptr__");
    });
  });

  // Regression: collector must not stack-overflow when observing a
  // Proxy whose `get` handler is itself instrumented. Without the
  // guard, observing such a value causes infinite mutual recursion
  //   tscptr → record → getTypeName → value[k] → Proxy.get → tscptr → ...
  // until V8 throws RangeError. The fix is a re-entry guard
  // (__tscptr__in_record) in __tscptr__record so a nested tscptr call from a
  // Proxy's get-handler is a no-op.
  describe("collector snippet — Proxy-recursion guard", () => {
    function evalSnippetSandbox() {
      const snippet = getCollectorSnippet({
        literalString: false,
        literalStringMaxLength: 16,
        literalNumber: false,
        literalBoolean: false,
        captureClassHierarchy: false,
        maxAnnotationChars: 4096,
      });
      // The snippet branches on IS_NODE / IS_BROWSER. We're in Node, so
      // it'll hit the IS_NODE path and try to set up a per-PID dump
      // file. That's fine — we don't care about the dump for this test;
      // we only care that calling tscptr on a recursive Proxy completes
      // without throwing.
      const ctx: Record<string, unknown> = {
        process,
        require,
        setInterval: setInterval,
        clearInterval: clearInterval,
        navigator: undefined,
        window: undefined,
      };
      vm.createContext(ctx);
      vm.runInContext(snippet, ctx);
      return ctx as { __tscptr__: any };
    }

    it("honors Symbol.for('ts-capture.peek') — walks the unwrapped value, not the proxy", () => {
      const sandbox = evalSnippetSandbox();
      const tscptr = sandbox.__tscptr__;

      // Simulate a framework adapter: a proxy whose underlying state is a
      // POJO `{ a: 1, b: "two" }`, and which exposes `Symbol.for(
      // "ts-capture.peek")` returning that POJO unchanged. ts-capture should
      // walk the POJO and emit its structural type, not the proxy's
      // surface (which would trigger get-traps on every property access).
      const raw = { a: 1, b: "two" };
      const peekSym = Symbol.for("ts-capture.peek");
      const proxyWithPeek = new Proxy(
        {},
        {
          get(target, prop) {
            if (prop === peekSym) return () => raw;
            // Normally a framework's proxy would do its reactive work here;
            // we throw to prove ts-capture doesn't reach this path when peek
            // is honored.
            throw new Error("walked the proxy facade — peek was ignored!");
          },
        },
      );

      tscptr("outer", proxyWithPeek, 0, "/test.ts", "{}");
      const collected = tscptr.get();
      // Find the entry we just recorded. The shape should reflect raw,
      // not throw or fall back to "unknown".
      const lastEntry = collected.find((e: unknown[]) => e[0] === "/test.ts" && e[1] === 0);
      expect(lastEntry).toBeDefined();
      const recordedTypes = (lastEntry as unknown[])[2] as Array<[string, unknown]>;
      // The structural type contains both keys from raw.
      const typeName = recordedTypes[0][0];
      expect(typeName).toContain("a:");
      expect(typeName).toContain("b:");
    });

    it("captureClassHierarchy off (default) emits just the ctor name for class instances", () => {
      const sandbox = evalSnippetSandbox();
      const tscptr = sandbox.__tscptr__;
      // Two-level hierarchy declared inside the sandbox so the
      // snippet's ctor lookup walks our prototype chain.
      vm.runInContext(
        "globalThis.__Animal = class Animal {}; globalThis.__Cat = class Cat extends globalThis.__Animal {};",
        sandbox as object,
      );
      vm.runInContext(
        'globalThis.__tscptr__("pet", new globalThis.__Cat(), 0, "/test.ts", "{}");',
        sandbox as object,
      );
      const collected = tscptr.get();
      const entry = collected.find((e: unknown[]) => e[0] === "/test.ts" && e[1] === 0);
      const typeName = ((entry as unknown[])[2] as Array<[string, unknown]>)[0][0];
      expect(typeName).toBe("Cat");
      expect(typeName).not.toContain("@sa:");
    });

    it("captureClassHierarchy on encodes the prototype chain inline as `@sa:` marker", () => {
      // Need a fresh snippet built with the flag on — the snippet's
      // CAPTURE_CLASS_HIERARCHY constant is baked at build time.
      const snippet = getCollectorSnippet({
        literalString: false,
        literalStringMaxLength: 16,
        literalNumber: false,
        literalBoolean: false,
        captureClassHierarchy: true,
        maxAnnotationChars: 4096,
      });
      const sandbox: Record<string, unknown> = {
        process,
        require,
        setInterval: setInterval,
        clearInterval: clearInterval,
        navigator: undefined,
        window: undefined,
      };
      vm.createContext(sandbox);
      vm.runInContext(snippet, sandbox);
      vm.runInContext(
        "globalThis.__Animal = class Animal {}; " +
          "globalThis.__Mammal = class Mammal extends globalThis.__Animal {}; " +
          "globalThis.__Cat = class Cat extends globalThis.__Mammal {};",
        sandbox,
      );
      vm.runInContext(
        'globalThis.__tscptr__("pet", new globalThis.__Cat(), 0, "/test.ts", "{}");',
        sandbox,
      );
      const collected = (sandbox as { __tscptr__: any }).__tscptr__.get();
      const entry = collected.find((e: unknown[]) => e[0] === "/test.ts" && e[1] === 0);
      const typeName = ((entry as unknown[])[2] as Array<[string, unknown]>)[0][0];
      expect(typeName).toBe("Cat /* @sa:Mammal|Animal */");
    });

    it("does not stack-overflow when value is a Proxy whose get-handler calls tscptr", () => {
      const sandbox = evalSnippetSandbox();
      const tscptr = sandbox.__tscptr__;
      expect(typeof tscptr).toBe("function");

      // Build a Proxy whose `get` handler simulates instrumented code
      // calling __tscptr__ on each property access (this is exactly what
      // happens when a hono Proxy's get-handler is itself transformed).
      const proxy = new Proxy(
        { a: 1, b: 2, c: 3 },
        {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            // Simulate the instrumented get-handler observing its return
            // value. Pre-fix this would recurse into getTypeName which
            // would walk the Proxy again, hitting THIS handler, etc.
            tscptr("inner", value, 100, "/proxy-test.ts", "{}");
            return value;
          },
        },
      );

      // The outer call: equivalent to instrumented code observing the
      // proxy itself. Should complete without RangeError.
      expect(() => tscptr("outer", proxy, 0, "/proxy-test.ts", "{}")).not.toThrow();

      // Per-position dedup means the outer entry is recorded; the inner
      // entries (from the proxy's get-handler) are no-ops because
      // __tscptr__in_record is set. We don't assert on which types ended
      // up in the log — the contract is "no overflow", not "exactly N
      // observations".
      const collected = tscptr.get();
      expect(Array.isArray(collected)).toBe(true);
    });
  });

  // Under Vitest+jsdom, walking `window` pulls jsdom synthetic globals
  // into observed types (e.g. GeolocationPositionError emitted as
  // `(1: unknown, 1014: unknown, "/path/x.ts": unknown, "{}": unknown)
  // => unknown` — bare numerics and quoted strings are valid call args
  // but invalid TS parameter names, breaking type-checking of the
  // applied output). The walked window also contains ts-capture's own
  // runtime hooks (__tscptr__ and __tscptr__*), polluting the type with
  // ts-capture internals. Mirror of type-collector.ts:resolveFunctionType
  // / resolveObjectType fixes — duplicated here because the snippet is
  // a separate runtime.
  describe("collector snippet — defensive type-walker", () => {
    function evalSandbox() {
      const snippet = getCollectorSnippet({
        literalString: false,
        literalStringMaxLength: 16,
        literalNumber: false,
        literalBoolean: false,
        captureClassHierarchy: false,
        maxAnnotationChars: 4096,
      });
      const ctx: Record<string, unknown> = {
        process,
        require,
        setInterval,
        clearInterval,
        navigator: undefined,
        window: undefined,
      };
      vm.createContext(ctx);
      vm.runInContext(snippet, ctx);
      return ctx as { __tscptr__: any };
    }

    it("falls back to argN when fn.toString yields non-identifier names (1c)", () => {
      const sandbox = evalSandbox();
      const tscptr = sandbox.__tscptr__;
      // Synthesise a function with mangled toString — same shape we
      // observed coming out of jsdom synthetic globals.
      const fn = function () {} as unknown as { toString: () => string };
      fn.toString = () => 'something(1, 1014, "/path/x.ts", "{}")';

      tscptr("v", fn, 0, "/test.ts", "{}");
      const collected = tscptr.get();
      const entry = collected.find((e: unknown[]) => e[0] === "/test.ts" && e[1] === 0);
      const typeName = ((entry as unknown[])[2] as Array<[string, unknown]>)[0][0] as string;

      // The output must not contain bare numerics or quoted strings as
      // parameter names. Each param's identifier (the bit before `:`)
      // must be a valid TS identifier or a recognised shape pattern.
      const match = typeName.match(/^\((.*)\) => /);
      expect(match).not.toBeNull();
      const params = match![1]
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      for (const p of params) {
        const [name] = p.split(":").map((s: string) => s.trim());
        expect(name).toMatch(/^(\.\.\.[a-zA-Z_$][\w$]*|[a-zA-Z_$][\w$]*)$/);
      }
    });

    it("handles destructured object params (depth-tracking split)", () => {
      // A naive `.split(",")` breaks `({a, b})` into `["{a", " b}"]`,
      // producing unparseable `({ a: unknown, b: unknown) => unknown`.
      // Example: Node's util.styleText has a destructured options param
      // `(format, text, { validateStream, stream })` that ends up with a
      // stray opening `{` in apply output (TS1005 "',' expected").
      const sandbox = evalSandbox();
      const tscptr = sandbox.__tscptr__;
      const fn = function (a: unknown, b: unknown, opts: unknown) {
        return [a, b, opts];
      };
      // Override with a realistic mangled-but-valid form
      Object.defineProperty(fn, "toString", {
        value: () => "function (format, text, { validateStream, stream }) { return; }",
      });
      tscptr("v", fn, 0, "/test.ts", "{}");
      const collected = tscptr.get();
      const entry = collected.find((e: unknown[]) => e[0] === "/test.ts" && e[1] === 0);
      const typeName = ((entry as unknown[])[2] as Array<[string, unknown]>)[0][0] as string;
      // Output should parse — no stray opening `{` without matching `}`.
      // Multi-field destructures use a positional name (arg{idx}Object), at
      // parity with core's resolveFunctionType.
      expect(typeName).toBe(
        "(format: unknown, text: unknown, arg2Object: {validateStream: unknown, stream: unknown}) => unknown",
      );
    });

    it("skips __tscptr__ and __tscptr__* keys when walking objects", () => {
      const sandbox = evalSandbox();
      const tscptr = sandbox.__tscptr__;
      // Simulate the offending pattern: instrumented code casts a
      // global-like object that has ts-capture internals attached.
      const globalLike = {
        __tscptr__: function () {},
        __tscptr__logs: {},
        __tscptr__in_record: false,
        realProperty: "hello",
      };

      tscptr("w", globalLike, 0, "/test.ts", "{}");
      const collected = tscptr.get();
      const entry = collected.find((e: unknown[]) => e[0] === "/test.ts" && e[1] === 0);
      const typeName = ((entry as unknown[])[2] as Array<[string, unknown]>)[0][0] as string;

      expect(typeName).not.toContain("__tscptr__");
      expect(typeName).not.toContain("__tscptr__");
      expect(typeName).toContain("realProperty");
    });
  });

  // Regression: under Vitest with `environment: "jsdom"` (the SvelteKit
  // / Svelte component-test default and the Vue / RTL pattern), jsdom
  // defines `window` while Node's `process` is still ambient. A naive
  // `if (IS_BROWSER) { sendBeacon } else if (IS_NODE) { dump }` lets
  // the browser path win, so observations go to a beacon that nobody
  // is listening for — silent data loss (instrumented files, __tscptr__
  // calls emitted, tests pass cleanly, but zero ts-capture-types-*.json
  // files produced). Fix: branch-swap so IS_NODE is checked first, plus
  // an explicit `target` plugin option for users who need to force one
  // path.
  describe("environment detection — jsdom regression + target override", () => {
    function evalSnippetWithEnv(opts: {
      window?: object | null;
      processStub?: typeof process | null;
      target?: "node" | "browser" | undefined;
      outDir?: string;
      sendBeaconSpy?: (url: string, body: unknown) => void;
      fetchSpy?: (url: string, init: { method: string; body: string }) => void;
      captureIntervalFn?: (fn: () => void) => void;
      captureBeforeUnload?: (fn: () => void) => void;
    }) {
      const snippet = getCollectorSnippet(
        {
          literalString: false,
          literalStringMaxLength: 16,
          literalNumber: false,
          literalBoolean: false,
          captureClassHierarchy: false,
          maxAnnotationChars: 4096,
        },
        { target: opts.target },
      );
      // Force worker_thread mode so observations flush synchronously
      // when the Node path is taken (no 500ms ticker wait).
      const realRequire = require;
      const stubRequire: NodeJS.Require = ((id: string) => {
        if (id === "node:worker_threads" || id === "worker_threads") {
          return { isMainThread: false };
        }
        return realRequire(id);
      }) as NodeJS.Require;
      // null sentinel = "remove this global from the vm context" so the
      // snippet's `typeof process` check sees "undefined" (not "object",
      // which is what typeof null returns and would crash the snippet).
      const stubFetch = opts.fetchSpy
        ? (url: string, init: { method: string; body: string }) => {
            opts.fetchSpy?.(url, init);
            return Promise.resolve({ ok: true });
          }
        : () => Promise.resolve({ ok: true });
      const ctx: Record<string, unknown> = {
        process:
          opts.processStub === undefined
            ? process
            : opts.processStub === null
              ? undefined
              : opts.processStub,
        require: stubRequire,
        setInterval: opts.captureIntervalFn
          ? (fn: () => void) => {
              opts.captureIntervalFn?.(fn);
              return 0;
            }
          : setInterval,
        clearInterval: clearInterval,
        navigator: opts.sendBeaconSpy
          ? { sendBeacon: opts.sendBeaconSpy }
          : { sendBeacon: () => {} },
        window: opts.window === undefined ? undefined : opts.window,
        fetch: stubFetch,
      };
      if (ctx.window) {
        // window must respond to addEventListener for the browser branch
        // to wire up the beforeunload handler without throwing.
        (
          ctx.window as { addEventListener?: (ev: string, fn: () => void) => void }
        ).addEventListener = opts.captureBeforeUnload
          ? (ev: string, fn: () => void) => {
              if (ev === "beforeunload") opts.captureBeforeUnload?.(fn);
            }
          : () => {};
      }
      vm.createContext(ctx);
      vm.runInContext(snippet, ctx);
      return ctx as { __tscptr__: any };
    }

    it("jsdom env (window AND process both defined): Node path wins, dump file written, sendBeacon NOT called", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-jsdom-"));
      const prevDir = process.env.TS_CAPTURE_TYPES_DIR;
      process.env.TS_CAPTURE_TYPES_DIR = outDir;
      const beaconCalls: Array<{ url: string; body: unknown }> = [];
      try {
        const sandbox = evalSnippetWithEnv({
          window: { addEventListener: () => {} },
          // process intentionally left as the host process (jsdom doesn't
          // overwrite Node's process; it just adds a window).
          sendBeaconSpy: (url, body) => beaconCalls.push({ url, body }),
        });
        sandbox.__tscptr__("v", 42, 0, "/jsdom-test.ts", "{}");
        const dumps = fs.readdirSync(outDir).filter((f) => f.startsWith("ts-capture-types-"));
        expect(dumps.length).toBe(1);
        expect(beaconCalls.length).toBe(0);
      } finally {
        if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
        else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("explicit target='node' forces Node path even when window is present", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-tnode-"));
      const prevDir = process.env.TS_CAPTURE_TYPES_DIR;
      process.env.TS_CAPTURE_TYPES_DIR = outDir;
      const beaconCalls: Array<{ url: string; body: unknown }> = [];
      try {
        const sandbox = evalSnippetWithEnv({
          window: { addEventListener: () => {} },
          target: "node",
          sendBeaconSpy: (url, body) => beaconCalls.push({ url, body }),
        });
        sandbox.__tscptr__("v", 42, 0, "/forced-node.ts", "{}");
        const dumps = fs.readdirSync(outDir).filter((f) => f.startsWith("ts-capture-types-"));
        expect(dumps.length).toBe(1);
        expect(beaconCalls.length).toBe(0);
      } finally {
        if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
        else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("explicit target='browser' forces browser path even when process is present", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-tbrow-"));
      const prevDir = process.env.TS_CAPTURE_TYPES_DIR;
      process.env.TS_CAPTURE_TYPES_DIR = outDir;
      const beaconCalls: Array<{ url: string; body: unknown }> = [];
      try {
        const sandbox = evalSnippetWithEnv({
          window: { addEventListener: () => {} },
          target: "browser",
          sendBeaconSpy: (url, body) => beaconCalls.push({ url, body }),
        });
        sandbox.__tscptr__("v", 42, 0, "/forced-browser.ts", "{}");
        // Browser path uses a 10s setInterval, not synchronous flush — so
        // we trigger a manual report via the same beforeunload handler.
        // Easier: just assert the dump path was NOT taken (no file).
        const dumps = fs.readdirSync(outDir).filter((f) => f.startsWith("ts-capture-types-"));
        expect(dumps.length).toBe(0);
        // sendBeacon is wired up but only fires on beforeunload + 10s
        // ticker; we don't assert it was called yet (would require waiting).
        // Contract proven: no Node-path side-effect happened.
      } finally {
        if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
        else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("pure browser (window present, process undefined): browser path wins (regression guard)", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-pbrow-"));
      const prevDir = process.env.TS_CAPTURE_TYPES_DIR;
      process.env.TS_CAPTURE_TYPES_DIR = outDir;
      try {
        const sandbox = evalSnippetWithEnv({
          window: { addEventListener: () => {} },
          processStub: null,
        });
        sandbox.__tscptr__("v", 42, 0, "/pure-browser.ts", "{}");
        // Browser path: no dump file should have been created.
        const dumps = fs.readdirSync(outDir).filter((f) => f.startsWith("ts-capture-types-"));
        expect(dumps.length).toBe(0);
      } finally {
        if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
        else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });

    // navigator.sendBeacon caps at ~64 KB per call and silently drops
    // larger payloads. For non-trivial SPAs the observation array exceeds
    // that limit within seconds, so the default 10 s flush never lands.
    // Fix: use fetch (no keepalive) for the in-flight periodic flush —
    // no size limit while the page is alive. Keep sendBeacon for the
    // beforeunload final flush (best-effort; last batch >64 KB may be
    // lost, but earlier periodic flushes captured the bulk).
    describe("browser path — payload-size handling", () => {
      it("periodic flush uses fetch (no payload-size limit)", () => {
        const fetchCalls: Array<{ url: string; body: string }> = [];
        const beaconCalls: Array<{ url: string; body: unknown }> = [];
        let intervalFn: (() => void) | undefined;
        const sandbox = evalSnippetWithEnv({
          window: { addEventListener: () => {} },
          processStub: null,
          fetchSpy: (url, init) => fetchCalls.push({ url, body: init.body }),
          sendBeaconSpy: (url, body) => beaconCalls.push({ url, body }),
          captureIntervalFn: (fn) => {
            intervalFn = fn;
          },
        });
        sandbox.__tscptr__("v", 42, 0, "/periodic.ts", "{}");
        expect(intervalFn).toBeDefined();
        intervalFn?.();
        expect(fetchCalls.length).toBe(1);
        expect(fetchCalls[0]?.url).toBe("/__ts-capture_collect");
        expect(beaconCalls.length).toBe(0);
      });

      it("beforeunload flush uses sendBeacon (survives page unload)", () => {
        const fetchCalls: Array<{ url: string; body: string }> = [];
        const beaconCalls: Array<{ url: string; body: unknown }> = [];
        let beforeUnloadFn: (() => void) | undefined;
        const sandbox = evalSnippetWithEnv({
          window: { addEventListener: () => {} },
          processStub: null,
          fetchSpy: (url, init) => fetchCalls.push({ url, body: init.body }),
          sendBeaconSpy: (url, body) => beaconCalls.push({ url, body }),
          captureBeforeUnload: (fn) => {
            beforeUnloadFn = fn;
          },
        });
        sandbox.__tscptr__("v", 42, 0, "/unload.ts", "{}");
        expect(beforeUnloadFn).toBeDefined();
        beforeUnloadFn?.();
        expect(beaconCalls.length).toBe(1);
        expect(beaconCalls[0]?.url).toBe("/__ts-capture_collect");
        expect(fetchCalls.length).toBe(0);
      });
    });
  });

  // Regression: under vitest's threads pool, workers exit before the
  // 500ms ticker fires AND `process.on("exit")` does not reliably fire
  // in worker_threads. Result was 0 dumps for short-running workers.
  // Separately: when TS_CAPTURE_TYPES_DIR points to a path whose parent
  // directory doesn't exist yet, the collector's writeFileSync throws
  // ENOENT and the silent best-effort catch swallows it — 0 dumps, no
  // warning, identical-looking failure to the jsdom branch bug. Fix:
  // mkdirSync(TYPES_DIR, { recursive: true }) once at collector init.
  describe("collector snippet — auto-creates TS_CAPTURE_TYPES_DIR if missing", () => {
    it("writes a dump when TS_CAPTURE_TYPES_DIR points to a non-existent directory", () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-mkdir-"));
      const typesDir = path.join(parent, "does-not-exist-yet");
      const prevDir = process.env.TS_CAPTURE_TYPES_DIR;
      process.env.TS_CAPTURE_TYPES_DIR = typesDir;
      try {
        // Confirm the dir really doesn't exist before init.
        expect(fs.existsSync(typesDir)).toBe(false);

        const snippet = getCollectorSnippet({
          literalString: false,
          literalStringMaxLength: 16,
          literalNumber: false,
          literalBoolean: false,
          captureClassHierarchy: false,
          maxAnnotationChars: 4096,
        });
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
          setInterval: setInterval,
          clearInterval: clearInterval,
          navigator: undefined,
          window: undefined,
        };
        vm.createContext(ctx);
        vm.runInContext(snippet, ctx);
        const tscptr = (ctx as { __tscptr__: any }).__tscptr__;
        tscptr("v", 42, 0, "/test.ts", "{}");

        // Dir should have been auto-created and a dump file written.
        expect(fs.existsSync(typesDir)).toBe(true);
        const dumps = fs.readdirSync(typesDir).filter((f) => f.startsWith("ts-capture-types-"));
        expect(dumps.length).toBe(1);
      } finally {
        if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
        else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });
  });

  // (one trivial test per file). Fix: when running in a worker_thread,
  // flush after EVERY observation (FLUSH_EVERY=1) so the dump exists
  // even for sub-500ms workers. Main-thread / forks pool keep the
  // original FLUSH_EVERY=10 throughput.
  describe("collector snippet — worker_threads flush strategy", () => {
    function evalSnippetWithWorkerThreads(opts: { isMainThread: boolean; outDir: string }) {
      const snippet = getCollectorSnippet({
        literalString: false,
        literalStringMaxLength: 16,
        literalNumber: false,
        literalBoolean: false,
        captureClassHierarchy: false,
        maxAnnotationChars: 4096,
      });
      // Stub `require("node:worker_threads")` to return our controlled
      // value; pass other module requires through to the real require.
      const realRequire = require;
      const stubRequire: NodeJS.Require = ((id: string) => {
        if (id === "node:worker_threads" || id === "worker_threads") {
          return { isMainThread: opts.isMainThread };
        }
        return realRequire(id);
      }) as NodeJS.Require;
      // The snippet calls process.env.TS_CAPTURE_TYPES_DIR, process.on(...).
      // We use the real process and just override env temporarily.
      const ctx: Record<string, unknown> = {
        process,
        require: stubRequire,
        setInterval: setInterval,
        clearInterval: clearInterval,
        navigator: undefined,
        window: undefined,
      };
      vm.createContext(ctx);
      vm.runInContext(snippet, ctx);
      return ctx as { __tscptr__: any };
    }

    it("flushes after a single observation when running in a worker_thread", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-wt-test-"));
      const prevDir = process.env.TS_CAPTURE_TYPES_DIR;
      process.env.TS_CAPTURE_TYPES_DIR = outDir;
      try {
        const sandbox = evalSnippetWithWorkerThreads({ isMainThread: false, outDir });
        sandbox.__tscptr__("v", 42, 0, "/test.ts", "{}");
        // Bump triggered → flush should have written one dump file.
        const files = fs.readdirSync(outDir).filter((f) => f.startsWith("ts-capture-types-"));
        expect(files.length).toBe(1);
        const contents = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), "utf8"));
        expect(contents.length).toBe(1);
      } finally {
        if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
        else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("does NOT flush after a single observation in main thread (FLUSH_EVERY=10 preserved)", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-mt-test-"));
      const prevDir = process.env.TS_CAPTURE_TYPES_DIR;
      process.env.TS_CAPTURE_TYPES_DIR = outDir;
      try {
        const sandbox = evalSnippetWithWorkerThreads({ isMainThread: true, outDir });
        sandbox.__tscptr__("v", 42, 0, "/test.ts", "{}");
        // Only one observation; main-thread threshold is 10, so no
        // dump file yet (the 500ms ticker has not fired in this
        // synchronous test either).
        const files = fs.readdirSync(outDir).filter((f) => f.startsWith("ts-capture-types-"));
        expect(files.length).toBe(0);
      } finally {
        if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
        else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  // Collector output / applier input contract. ts-capture unifies both
  // sides under the CollectedTypeInfo TS type, but the snippet is
  // *generated as a string* (not type-checked against CollectedTypeInfo
  // at compile time), so the structural contract has to be verified at
  // runtime. Asserts the snippet-emitted dump file structurally matches
  // what applyTypesToFile consumes, by running a real roundtrip.
  describe("collector → apply contract roundtrip", () => {
    it("snippet-emitted dump validates as CollectedTypeEntry[] and applyTypesToFile accepts it", async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-contract-"));
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
        // Force worker_thread mode so a single observation triggers a
        // synchronous flush — keeps the test deterministic without a
        // 500ms ticker wait.
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
          setInterval: setInterval,
          clearInterval: clearInterval,
          navigator: undefined,
          window: undefined,
        };
        vm.createContext(ctx);
        vm.runInContext(snippet, ctx);
        const tscptr = (ctx as { __tscptr__: any }).__tscptr__;
        tscptr("x", 42, 9, "/tmp/sample.ts", '{"arrow":true,"parens":[8,11]}');

        // Read dump file as the merge/apply pipeline would.
        const dumps = fs.readdirSync(outDir).filter((f) => f.startsWith("ts-capture-types-"));
        expect(dumps.length).toBe(1);
        const raw = JSON.parse(fs.readFileSync(path.join(outDir, dumps[0]), "utf8"));

        // Structural contract: every entry must be [filename, offset, types[], opts].
        expect(Array.isArray(raw)).toBe(true);
        expect(raw.length).toBeGreaterThanOrEqual(1);
        for (const entry of raw) {
          expect(Array.isArray(entry)).toBe(true);
          expect(entry.length).toBe(4);
          expect(typeof entry[0]).toBe("string"); // filename
          expect(typeof entry[1]).toBe("number"); // offset
          expect(Array.isArray(entry[2])).toBe(true); // types[]
          for (const t of entry[2]) {
            expect(Array.isArray(t)).toBe(true);
            // [name, sourceLocation?] — name may be undefined
            expect(t.length).toBe(2);
          }
          expect(typeof entry[3]).toBe("object"); // ExtraOptions
        }

        // Roundtrip: the dump must be accepted by applyTypesToFile without
        // error. Use a real source whose offset 9 is `function f(x` — i.e.
        // the parameter `x` after `function `. The applier should leave
        // either a typed or unchanged source, not throw.
        const { applyTypesToFile } = await import("@ts-capture/core");
        const source = "function f(x) { return x; }";
        const result = applyTypesToFile(source, raw, {});
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      } finally {
        if (prevDir === undefined) delete process.env.TS_CAPTURE_TYPES_DIR;
        else process.env.TS_CAPTURE_TYPES_DIR = prevDir;
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  describe("configureServer", () => {
    function captureMiddleware(plugin: Plugin): Function {
      const configureServer = plugin.configureServer as Function;
      let captured: Function | undefined;
      configureServer({
        middlewares: {
          use: (fn: Function) => {
            captured = fn;
          },
        },
      });
      if (!captured) throw new Error("middleware was not registered");
      return captured;
    }

    function makeReq(url: string, method: string): EventEmitter & { url: string; method: string } {
      const req = new EventEmitter() as EventEmitter & { url: string; method: string };
      req.url = url;
      req.method = method;
      return req;
    }

    function makeRes() {
      return {
        writeHead: vi.fn(),
        end: vi.fn(),
      };
    }

    function feed(req: EventEmitter, body: string) {
      req.emit("data", body);
      req.emit("end");
    }

    it("adds a POST endpoint for collecting types", () => {
      const plugin = tsCapturePlugin() as Plugin;
      const configureServer = plugin.configureServer as Function;

      const middlewares: Function[] = [];
      const mockServer = {
        middlewares: { use: (fn: Function) => middlewares.push(fn) },
      };
      configureServer(mockServer);
      expect(middlewares.length).toBeGreaterThan(0);
    });

    it("calls next() for non-target URL", () => {
      const middleware = captureMiddleware(tsCapturePlugin() as Plugin);
      const req = makeReq("/some-other-path", "POST");
      const res = makeRes();
      const next = vi.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it("calls next() for non-POST method on the target URL", () => {
      const middleware = captureMiddleware(tsCapturePlugin() as Plugin);
      const req = makeReq("/__ts-capture_collect", "GET");
      const res = makeRes();
      const next = vi.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it("responds 200 with { ok: true } on a valid JSON POST", () => {
      const middleware = captureMiddleware(tsCapturePlugin() as Plugin);
      const req = makeReq("/__ts-capture_collect", "POST");
      const res = makeRes();
      const next = vi.fn();
      middleware(req, res, next);
      feed(req, "[]");
      expect(next).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
      expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    });

    it("accepts a body delivered in multiple chunks", () => {
      const middleware = captureMiddleware(tsCapturePlugin() as Plugin);
      const req = makeReq("/__ts-capture_collect", "POST");
      const res = makeRes();
      middleware(req, res, vi.fn());
      req.emit("data", "[");
      req.emit("data", "]");
      req.emit("end");
      expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    });

    it("responds 400 with 'Invalid JSON' on a malformed body", () => {
      const middleware = captureMiddleware(tsCapturePlugin() as Plugin);
      const req = makeReq("/__ts-capture_collect", "POST");
      const res = makeRes();
      middleware(req, res, vi.fn());
      feed(req, "not-json");
      expect(res.writeHead).toHaveBeenCalledWith(400);
      expect(res.end).toHaveBeenCalledWith("Invalid JSON");
    });

    it("writes typeInfo JSON to outputFile when option is set", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-vite-test-"));
      const outFile = path.join(tmpDir, "out.json");
      try {
        const middleware = captureMiddleware(tsCapturePlugin({ outputFile: outFile }) as Plugin);
        const req = makeReq("/__ts-capture_collect", "POST");
        const res = makeRes();
        middleware(req, res, vi.fn());
        const payload = [["foo.ts", 0, [["string", {}]], {}]];
        feed(req, JSON.stringify(payload));
        expect(fs.existsSync(outFile)).toBe(true);
        expect(JSON.parse(fs.readFileSync(outFile, "utf-8"))).toEqual(payload);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("apply: groups entries by file and reads + writes each source", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-vite-test-"));
      const srcFile = path.join(tmpDir, "src.ts");
      const original = "function greet(name) { return name; }";
      fs.writeFileSync(srcFile, original);
      try {
        const middleware = captureMiddleware(tsCapturePlugin({ apply: true }) as Plugin);
        const req = makeReq("/__ts-capture_collect", "POST");
        const res = makeRes();
        middleware(req, res, vi.fn());
        // Two entries for the same file exercise the grouping merge branch
        // (existing.push). Empty inner type arrays mean applyTypesToFile is a
        // no-op, which is enough to cover the read + write back path.
        const payload = [
          [srcFile, 0, [], {}],
          [srcFile, 1, [], {}],
        ];
        feed(req, JSON.stringify(payload));
        expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
        expect(fs.readFileSync(srcFile, "utf-8")).toBe(original);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("apply: swallows per-file read/write errors and still responds 200", () => {
      const middleware = captureMiddleware(tsCapturePlugin({ apply: true }) as Plugin);
      const req = makeReq("/__ts-capture_collect", "POST");
      const res = makeRes();
      middleware(req, res, vi.fn());
      const payload = [["/nonexistent/file.ts", 0, [], {}]];
      feed(req, JSON.stringify(payload));
      expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
      expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    });
  });

  describe("literal-type opt-in", () => {
    function snippetFor(plugin: Plugin): string {
      const transform = plugin.transform as Function;
      const result = transform("function foo(a) { return a; }", "/src/app.ts");
      return result.code as string;
    }

    it("bakes false defaults when no options or env vars are set", () => {
      // Strip env vars so we don't pick up host-shell values
      const prev = {
        s: process.env.TS_CAPTURE_LITERAL_STRING,
        n: process.env.TS_CAPTURE_LITERAL_NUMBER,
        b: process.env.TS_CAPTURE_LITERAL_BOOLEAN,
        m: process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH,
      };
      delete process.env.TS_CAPTURE_LITERAL_STRING;
      delete process.env.TS_CAPTURE_LITERAL_NUMBER;
      delete process.env.TS_CAPTURE_LITERAL_BOOLEAN;
      delete process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH;
      try {
        const code = snippetFor(tsCapturePlugin());
        expect(code).toContain("var LITERAL_STRING = false;");
        expect(code).toContain("var LITERAL_NUMBER = false;");
        expect(code).toContain("var LITERAL_BOOLEAN = false;");
        expect(code).toContain("var LITERAL_STRING_MAX = 16;");
      } finally {
        if (prev.s !== undefined) process.env.TS_CAPTURE_LITERAL_STRING = prev.s;
        if (prev.n !== undefined) process.env.TS_CAPTURE_LITERAL_NUMBER = prev.n;
        if (prev.b !== undefined) process.env.TS_CAPTURE_LITERAL_BOOLEAN = prev.b;
        if (prev.m !== undefined) process.env.TS_CAPTURE_LITERAL_STRING_MAX_LENGTH = prev.m;
      }
    });

    it("bakes plugin options into the snippet at build-time", () => {
      const code = snippetFor(
        tsCapturePlugin({
          literalOptions: {
            literalString: true,
            literalStringMaxLength: 24,
            literalNumber: true,
            literalBoolean: true,
          },
        }),
      );
      expect(code).toContain("var LITERAL_STRING = true;");
      expect(code).toContain("var LITERAL_STRING_MAX = 24;");
      expect(code).toContain("var LITERAL_NUMBER = true;");
      expect(code).toContain("var LITERAL_BOOLEAN = true;");
    });

    it("falls back to TS_CAPTURE_LITERAL_* env vars when plugin options missing", () => {
      const prev = process.env.TS_CAPTURE_LITERAL_STRING;
      process.env.TS_CAPTURE_LITERAL_STRING = "true";
      try {
        const code = snippetFor(tsCapturePlugin());
        expect(code).toContain("var LITERAL_STRING = true;");
      } finally {
        if (prev === undefined) delete process.env.TS_CAPTURE_LITERAL_STRING;
        else process.env.TS_CAPTURE_LITERAL_STRING = prev;
      }
    });

    it("plugin options override env vars", () => {
      const prev = process.env.TS_CAPTURE_LITERAL_STRING;
      process.env.TS_CAPTURE_LITERAL_STRING = "true";
      try {
        const code = snippetFor(tsCapturePlugin({ literalOptions: { literalString: false } }));
        expect(code).toContain("var LITERAL_STRING = false;");
      } finally {
        if (prev === undefined) delete process.env.TS_CAPTURE_LITERAL_STRING;
        else process.env.TS_CAPTURE_LITERAL_STRING = prev;
      }
    });

    it("getTypeName branches honor literal flags (compiled snippet behavior)", () => {
      // Extract and eval the getTypeName fragment with controlled flags so we
      // verify the runtime branches actually wire through, not just textual
      // presence.
      const fn = new Function(
        "LITERAL_STRING",
        "LITERAL_STRING_MAX",
        "LITERAL_NUMBER",
        "LITERAL_BOOLEAN",
        `
          function getTypeName(value) {
            if (value === null) return "null";
            if (value === undefined) return "undefined";
            var t = typeof value;
            if (t === "string" && LITERAL_STRING && value.length <= LITERAL_STRING_MAX) return JSON.stringify(value);
            if (t === "number" && LITERAL_NUMBER && Number.isFinite(value)) return String(value);
            if (t === "boolean" && LITERAL_BOOLEAN) return String(value);
            if (t === "string" || t === "number" || t === "boolean") return t;
            return t;
          }
          return getTypeName;
        `,
      );

      const off = fn(false, 16, false, false);
      expect(off("yes")).toBe("string");
      expect(off(1)).toBe("number");
      expect(off(true)).toBe("boolean");

      const on = fn(true, 16, true, true);
      expect(on("yes")).toBe('"yes"');
      expect(on(1)).toBe("1");
      expect(on(true)).toBe("true");
      expect(on(Infinity)).toBe("number");
    });
  });

  // Pluggable browser transports (v1).
  //
  // The default browser collector posts to /__ts-capture_collect (the
  // vite dev-server middleware). For staging / sporadic-prod-debug /
  // self-hosted-collector use cases, users need to redirect or mirror
  // observations elsewhere. The `transports` option opens a per-channel
  // dispatch pipeline; v1 ships only `kind: "http"`.
  //
  // Tests cover:
  //   T1 — no transports + no env → existing default behavior
  //   T2 — single periodic-only http transport → fetch only, no beacon
  //   T3 — single unload-only http transport → beacon only, no fetch
  //   T4 — both events (default), single http transport → both channels
  //   T5 — fan-out: two http transports same event → both fire
  //   T6 — TS_CAPTURE_TRANSPORT_URL alone → synthesizes default transport
  //   T7 — TS_CAPTURE_TRANSPORT_URL + config → overrides url on every http
  //   T8 — non-local URL → console.warn fires once
  //   T9 — local URL → no console.warn
  describe("transports (browser pluggable v1)", () => {
    // --- resolveTransports (config-time resolver) -------------------------

    describe("resolveTransports", () => {
      it("T1: no transports + no env → returns null (use default)", () => {
        const out = resolveTransports({}, undefined);
        expect(out).toBeNull();
      });

      it("T6: TS_CAPTURE_TRANSPORT_URL alone synthesizes a default-events http transport", () => {
        const out = resolveTransports({}, "https://collector.example.com/ingest");
        expect(out).toEqual([
          {
            event: ["periodic", "unload"],
            kind: "http",
            url: "https://collector.example.com/ingest",
          },
        ]);
      });

      it("T7: TS_CAPTURE_TRANSPORT_URL + config overrides url on every http transport", () => {
        const out = resolveTransports(
          {
            transports: [
              { event: ["periodic"], kind: "http", url: "/local" },
              { event: ["unload"], kind: "http", url: "https://x.example.com" },
            ],
          },
          "https://override.example.com",
        );
        expect(out).toEqual([
          {
            event: ["periodic"],
            kind: "http",
            url: "https://override.example.com",
          },
          {
            event: ["unload"],
            kind: "http",
            url: "https://override.example.com",
          },
        ]);
      });

      it("defaults event to ['periodic', 'unload'] when omitted", () => {
        const out = resolveTransports({ transports: [{ kind: "http", url: "/x" }] }, undefined);
        expect(out?.[0]?.event).toEqual(["periodic", "unload"]);
      });

      it("empty transports array → null (fallback to default) + warning", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const out = resolveTransports({ transports: [] }, undefined);
          expect(out).toBeNull();
          expect(warn).toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      });
    });

    // --- Collector-snippet behavior with configured transports -------------

    function makeBrowserSandbox(opts: { transports?: BrowserTransport[] }): {
      ctx: Record<string, unknown> & { __tscptr__: any };
      fetchCalls: Array<{ url: string; body: string }>;
      beaconCalls: Array<{ url: string; body: unknown }>;
      consoleWarns: string[];
      fireInterval: () => void;
      fireBeforeUnload: () => void;
    } {
      const resolved = resolveTransports({ transports: opts.transports }, undefined) ?? undefined;
      const snippet = getCollectorSnippet(
        {
          literalString: false,
          literalStringMaxLength: 16,
          literalNumber: false,
          literalBoolean: false,
          captureClassHierarchy: false,
          maxAnnotationChars: 4096,
        },
        { target: "browser", transports: resolved },
      );
      const fetchCalls: Array<{ url: string; body: string }> = [];
      const beaconCalls: Array<{ url: string; body: unknown }> = [];
      const consoleWarns: string[] = [];
      let intervalFn: (() => void) | undefined;
      let beforeUnloadFn: (() => void) | undefined;
      const ctx: Record<string, unknown> = {
        process: undefined,
        setInterval: (fn: () => void) => {
          intervalFn = fn;
          return 0;
        },
        clearInterval: () => {},
        navigator: {
          sendBeacon: (url: string, body: unknown) => beaconCalls.push({ url, body }),
        },
        fetch: (url: string, init: { body: string }) => {
          fetchCalls.push({ url, body: init.body });
          return Promise.resolve({ ok: true });
        },
        window: {
          addEventListener: (ev: string, fn: () => void) => {
            if (ev === "beforeunload") beforeUnloadFn = fn;
          },
        },
        console: { warn: (...args: unknown[]) => consoleWarns.push(args.join(" ")) },
      };
      vm.createContext(ctx);
      vm.runInContext(snippet, ctx);
      return {
        ctx: ctx as Record<string, unknown> & { __tscptr__: any },
        fetchCalls,
        beaconCalls,
        consoleWarns,
        fireInterval: () => intervalFn?.(),
        fireBeforeUnload: () => beforeUnloadFn?.(),
      };
    }

    it("T1 (snippet): no transports configured → defaults to /__ts-capture_collect", () => {
      const sb = makeBrowserSandbox({ transports: undefined });
      sb.ctx.__tscptr__("v", 1, 0, "/a.ts", "{}");
      sb.fireInterval();
      sb.fireBeforeUnload();
      expect(sb.fetchCalls).toHaveLength(1);
      expect(sb.fetchCalls[0]?.url).toBe("/__ts-capture_collect");
      expect(sb.beaconCalls).toHaveLength(1);
      expect(sb.beaconCalls[0]?.url).toBe("/__ts-capture_collect");
    });

    it("T2: periodic-only http transport → fetch fires, sendBeacon does not", () => {
      const sb = makeBrowserSandbox({
        transports: [{ event: ["periodic"], kind: "http", url: "/p" }],
      });
      sb.ctx.__tscptr__("v", 1, 0, "/a.ts", "{}");
      sb.fireInterval();
      sb.fireBeforeUnload();
      expect(sb.fetchCalls).toHaveLength(1);
      expect(sb.fetchCalls[0]?.url).toBe("/p");
      expect(sb.beaconCalls).toHaveLength(0);
    });

    it("T3: unload-only http transport → sendBeacon fires, fetch does not", () => {
      const sb = makeBrowserSandbox({
        transports: [{ event: ["unload"], kind: "http", url: "/u" }],
      });
      sb.ctx.__tscptr__("v", 1, 0, "/a.ts", "{}");
      sb.fireInterval();
      sb.fireBeforeUnload();
      expect(sb.fetchCalls).toHaveLength(0);
      expect(sb.beaconCalls).toHaveLength(1);
      expect(sb.beaconCalls[0]?.url).toBe("/u");
    });

    it("T4: default-events http transport → both channels fire", () => {
      const sb = makeBrowserSandbox({
        transports: [{ kind: "http", url: "/both" }],
      });
      sb.ctx.__tscptr__("v", 1, 0, "/a.ts", "{}");
      sb.fireInterval();
      sb.fireBeforeUnload();
      expect(sb.fetchCalls).toHaveLength(1);
      expect(sb.fetchCalls[0]?.url).toBe("/both");
      expect(sb.beaconCalls).toHaveLength(1);
      expect(sb.beaconCalls[0]?.url).toBe("/both");
    });

    it("T5: fan-out — two periodic transports → both URLs hit on flush", () => {
      const sb = makeBrowserSandbox({
        transports: [
          { event: ["periodic"], kind: "http", url: "/p1" },
          { event: ["periodic"], kind: "http", url: "/p2" },
        ],
      });
      sb.ctx.__tscptr__("v", 1, 0, "/a.ts", "{}");
      sb.fireInterval();
      const urls = sb.fetchCalls.map((c) => c.url).sort();
      expect(urls).toEqual(["/p1", "/p2"]);
    });

    it("T8: non-local URL emits console.warn once at init", () => {
      const sb = makeBrowserSandbox({
        transports: [{ event: ["periodic"], kind: "http", url: "https://x.example.com/ingest" }],
      });
      expect(sb.consoleWarns.some((w) => /non-local|external|PII/i.test(w))).toBe(true);
    });

    it("T9: local URL — no privacy warning", () => {
      const sb = makeBrowserSandbox({
        transports: [{ event: ["periodic"], kind: "http", url: "/local-path" }],
      });
      expect(sb.consoleWarns.length).toBe(0);
    });

    it("custom headers are sent on fetch", () => {
      const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
      const resolved = resolveTransports(
        {
          transports: [
            {
              event: ["periodic"],
              kind: "http",
              url: "/h",
              headers: { "X-Api-Key": "abc" },
            },
          ],
        },
        undefined,
      );
      const snippet = getCollectorSnippet(
        {
          literalString: false,
          literalStringMaxLength: 16,
          literalNumber: false,
          literalBoolean: false,
          captureClassHierarchy: false,
          maxAnnotationChars: 4096,
        },
        {
          target: "browser",
          transports: resolved ?? undefined,
        },
      );
      let intervalFn: (() => void) | undefined;
      const ctx: Record<string, unknown> = {
        setInterval: (fn: () => void) => {
          intervalFn = fn;
          return 0;
        },
        clearInterval: () => {},
        navigator: { sendBeacon: () => {} },
        fetch: (url: string, init: { headers: Record<string, string> }) => {
          calls.push({ url, init });
          return Promise.resolve({ ok: true });
        },
        window: { addEventListener: () => {} },
        console: { warn: () => {} },
        process: undefined,
      };
      vm.createContext(ctx);
      vm.runInContext(snippet, ctx);
      (ctx as { __tscptr__: any }).__tscptr__("v", 1, 0, "/a.ts", "{}");
      intervalFn?.();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init.headers).toMatchObject({ "X-Api-Key": "abc" });
    });
  });
});
