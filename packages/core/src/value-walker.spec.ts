import { describe, expect, it } from "vitest";

import type { LiteralOptions } from "./collector-contract.js";

import { getTypeName } from "./type-collector.js";
import { createValueWalker } from "./value-walker.js";

// Direct specs for the bound walker. Before
// the extraction, `reason` / `depthExceeded` / the re-entry verdict were only
// reachable by reading module globals immediately after a getTypeName call.
// Now they come back through WalkResult and can be asserted per value.

describe("createValueWalker → WalkResult", () => {
  it("returns kind:ok with type, no reason, no depth-exceed for a plain value", () => {
    const walk = createValueWalker();
    expect(walk({ a: 1, b: "two" })).toEqual({
      kind: "ok",
      type: "{ a: number, b: string }",
      reason: null,
      depthExceeded: false,
    });
  });

  it("returns null type for a primitive that walks to nothing (circular)", () => {
    const walk = createValueWalker();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = walk(cyclic);
    // The cycle short-circuits the inner walk to null → emitted as `unknown`.
    expect(result).toEqual({
      kind: "ok",
      type: "{ self: unknown }",
      reason: null,
      depthExceeded: false,
    });
  });

  it("flags depthExceeded when a branch bails at the depth limit", () => {
    const walk = createValueWalker({ maxDepth: 1 });
    const result = walk({ a: { b: 1 } });
    expect(result).toEqual({
      kind: "ok",
      type: "{ a: unknown }",
      reason: null,
      depthExceeded: true,
    });
  });

  it("flags shape-capped (reason + depthExceeded) when over maxAnnotationChars", () => {
    const walk = createValueWalker({ literalOptions: { maxAnnotationChars: 5 } });
    const result = walk({ aaa: 1, bbb: 2 });
    expect(result).toEqual({
      kind: "ok",
      type: "Record<string, unknown>",
      reason: "shape-capped",
      depthExceeded: true,
    });
  });

  it("short-circuits a re-entrant call on the SAME walker to kind:reentered", () => {
    const walk = createValueWalker();
    let inner: unknown = "unset";
    const proxy = new Proxy(
      { a: 1 },
      {
        get(target, prop, receiver) {
          if (inner === "unset") inner = walk({ b: 2 });
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const outer = walk(proxy);
    expect(inner).toEqual({ kind: "reentered" });
    expect(outer.kind).toBe("ok");
  });

  it("two independent walkers do not false-trip each other's guard", () => {
    const a = createValueWalker();
    const b = createValueWalker();
    let innerB: unknown = "unset";
    const proxy = new Proxy(
      { x: 1 },
      {
        get(target, prop, receiver) {
          // A different walker re-entered from within A's walk still runs.
          if (innerB === "unset") innerB = b({ y: 2 });
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    a(proxy);
    expect(innerB).toEqual({
      kind: "ok",
      type: "{ y: number }",
      reason: null,
      depthExceeded: false,
    });
  });
});

describe("getTypeName ≡ createValueWalker projection", () => {
  // The back-compat shim must be a pure projection of the new core:
  //   getTypeName(v) === project(createValueWalker(cfg)(v))
  // so the two paths cannot drift.
  const project = (r: ReturnType<ReturnType<typeof createValueWalker>>): string | null =>
    r.kind === "reentered" ? null : r.type;

  const OPTS: LiteralOptions = { literalString: true, literalNumber: true };
  const corpus: unknown[] = [
    "hello",
    42,
    true,
    null,
    undefined,
    { a: 1, b: { c: 2 } },
    [1, 2, 3],
    ["a", "b"],
    (x: number) => x,
    new Map([["k", 1]]),
    new Set([1, 2]),
    Promise.resolve(1),
    new (class Widget {})(),
  ];

  corpus.forEach((value, i) => {
    it(`case ${i}: ${String(Array.isArray(value) ? "array" : typeof value)}`, () => {
      const viaWalker = project(createValueWalker({ maxDepth: 5, literalOptions: OPTS })(value));
      expect(getTypeName(value, 5, OPTS)).toBe(viaWalker);
    });
  });
});
