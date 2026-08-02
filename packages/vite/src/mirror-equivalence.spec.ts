import type { LiteralOptions } from "@ts-capture/core";

import { getTypeName } from "@ts-capture/core";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { getCollectorSnippet } from "./index.js";

// Equivalence guard. `packages/vite` cannot import the core walker — the
// injected runtime snippet hand-mirrors `resolveFunctionType`,
// `getInheritanceChain`, and `TS_CAPTURE_INTERNAL_KEY` as a standalone string
// (see `getCollectorSnippet` / `__tscptr__getTypeName`, index.ts). Nothing in
// the type system enforces that the mirror tracks core, so this test does.
//
// It runs one value corpus through BOTH paths and asserts the emitted type
// strings are equal:
//   - core:  getTypeName(value, 5, opts)
//   - vite:  the snippet's __tscptr__ collector, evaluated in a vm sandbox
//
// The mirror was originally found to have drifted in three categories
// (param-naming, object-rest, async/generator returns); it was reconciled to
// parity in fix(vite). If this test goes red again, the mirror has re-drifted
// — fix the snippet (index.ts __tscptr__getTypeName), do NOT loosen the
// assertion.

const OPTS_OFF: LiteralOptions = {
  literalString: false,
  literalStringMaxLength: 16,
  literalNumber: false,
  literalBoolean: false,
  captureClassHierarchy: false,
  maxAnnotationChars: 4096,
};

const OPTS_HIERARCHY: LiteralOptions = { ...OPTS_OFF, captureClassHierarchy: true };

/** Evaluate the injected collector runtime in an isolated vm context and
 *  expose its global `__tscptr__`. Mirrors the sandbox used by the
 *  Proxy-recursion guard test in index.spec.ts. */
function makeSandbox(opts: LiteralOptions) {
  const snippet = getCollectorSnippet({
    literalString: opts.literalString ?? false,
    literalStringMaxLength: opts.literalStringMaxLength ?? 16,
    literalNumber: opts.literalNumber ?? false,
    literalBoolean: opts.literalBoolean ?? false,
    captureClassHierarchy: opts.captureClassHierarchy ?? false,
    maxAnnotationChars: opts.maxAnnotationChars ?? 4096,
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
  return ctx as { __tscptr__: TsCaptureGlobal };
}

type CollectedEntry = [string, number, Array<[string, ...unknown[]]>];
interface TsCaptureGlobal {
  (name: string, value: unknown, offset: number, file: string, declJson: string): void;
  get(): CollectedEntry[];
}

/** Record one value through the snippet runtime at a unique offset and return
 *  the single emitted type string (or null if nothing was recorded). */
function viteType(
  sandbox: { __tscptr__: TsCaptureGlobal },
  value: unknown,
  offset: number,
): string | null {
  sandbox.__tscptr__("v", value, offset, "/test.ts", "{}");
  const entry = sandbox.__tscptr__.get().find((e) => e[0] === "/test.ts" && e[1] === offset);
  if (!entry) return null;
  return entry[2][0][0];
}

describe("vite runtime mirror ≡ core walker", () => {
  describe("function signatures (resolveFunctionType mirror)", () => {
    // The highest-drift surface: both implementations re-derive a TS function
    // signature from `fn.toString()` via a depth-tracking arg split with
    // bespoke handling of native / class / destructured / rest / async /
    // generator forms. Each function object is passed to BOTH paths so
    // `toString()` is identical input. The mirror was reconciled to parity
    // with core (fix(vite)); these cases are the guard that keeps it there —
    // if one goes red, fix the mirror (index.ts __tscptr__getTypeName), do NOT
    // loosen the assertion.
    const fns: Array<{ label: string; fn: Function }> = [
      { label: "no params", fn: function f() {} },
      {
        label: "two named params",
        fn: function f(a: unknown, b: unknown) {
          return [a, b];
        },
      },
      { label: "arrow with parens", fn: (a: unknown, b: unknown) => [a, b] },
      { label: "arrow no parens", fn: (x: unknown) => x },
      {
        label: "rest param",
        fn: function f(...rest: unknown[]) {
          return rest;
        },
      },
      {
        label: "default values",
        fn: function f(a = 1, b = 2) {
          return a + b;
        },
      },
      {
        label: "destructured object param (multi-field → positional)",
        fn: function f({ a, b }: { a: unknown; b: unknown }) {
          return [a, b];
        },
      },
      {
        label: "destructured object param (single-field keeps name)",
        fn: function f({ a }: { a: unknown }) {
          return a;
        },
      },
      {
        label: "destructured object param (rename {prop: local})",
        fn: function f({ a: x }: { a: unknown }) {
          return x;
        },
      },
      {
        label: "destructured array param (multi-field → positional)",
        fn: function f([a, b]: unknown[]) {
          return [a, b];
        },
      },
      {
        label: "destructured array param (single-field keeps name)",
        fn: function f([a]: unknown[]) {
          return a;
        },
      },
      {
        label: "object param with rest (index signature)",
        fn: function f({ a, b, ...rest }: Record<string, unknown>) {
          return [a, b, rest];
        },
      },
      {
        label: "mixed params",
        fn: function f(
          a: unknown,
          { b, c }: Record<string, unknown>,
          [d, e]: unknown[],
          ...g: unknown[]
        ) {
          return [a, b, c, d, e, g];
        },
      },
      {
        label: "async function (=> Promise)",
        fn: async function f(a: unknown) {
          return a;
        },
      },
      {
        label: "generator (=> Generator)",
        fn: function* f() {
          yield 1;
        },
      },
      {
        label: "async generator (=> AsyncGenerator)",
        fn: async function* f() {
          yield 1;
        },
      },
      { label: "class constructor (=> typeof)", fn: class Widget {} },
      { label: "native function (=> Function)", fn: parseInt },
    ];

    fns.forEach(({ label, fn }, i) => {
      it(label, () => {
        const sandbox = makeSandbox(OPTS_OFF);
        const core = getTypeName(fn, 5, OPTS_OFF);
        const vite = viteType(sandbox, fn, i * 4);
        expect(vite).toBe(core);
      });
    });
  });

  describe("class hierarchy (getInheritanceChain mirror)", () => {
    // Classes are constructed inside the sandbox so the snippet's prototype
    // walk runs against the sandbox realm's Object.prototype, and constructed
    // identically in this (host) realm for the core walker. Both compute the
    // ctor name plus the inline `@sa:` chain comment from the prototype chain.
    const DECL = `
      class Animal {}
      class Mammal extends Animal {}
      class Cat extends Mammal {}
      globalThis.__tscptr__("v", new Cat(), 0, "/test.ts", "{}");
    `;

    class Animal {}
    class Mammal extends Animal {}
    class Cat extends Mammal {}

    it("ctor name only when captureClassHierarchy is off", () => {
      const sandbox = makeSandbox(OPTS_OFF);
      vm.runInContext(DECL, sandbox as object);
      const vite = sandbox.__tscptr__.get().find((e) => e[1] === 0)?.[2][0][0] ?? null;
      const core = getTypeName(new Cat(), 5, OPTS_OFF);
      expect(core).toBe("Cat");
      expect(vite).toBe(core);
    });

    it("inline @sa: chain when captureClassHierarchy is on", () => {
      const sandbox = makeSandbox(OPTS_HIERARCHY);
      vm.runInContext(DECL, sandbox as object);
      const vite = sandbox.__tscptr__.get().find((e) => e[1] === 0)?.[2][0][0] ?? null;
      const core = getTypeName(new Cat(), 5, OPTS_HIERARCHY);
      expect(core).toContain("@sa:");
      expect(vite).toBe(core);
    });
  });

  describe("internal-key filtering (TS_CAPTURE_INTERNAL_KEY mirror)", () => {
    it("strips __tscptr* keys from observed object shapes", () => {
      const sandbox = makeSandbox(OPTS_OFF);
      const value = { a: 1, __tscptr__: () => {}, __tscptr__logs: 1, b: "two" };
      const core = getTypeName(value, 5, OPTS_OFF);
      const vite = viteType(sandbox, value, 0);
      expect(core).not.toContain("__tscptr");
      expect(vite).toBe(core);
    });
  });
});
