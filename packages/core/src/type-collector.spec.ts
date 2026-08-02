import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { CollectionContext } from "./type-collector.js";

import {
  applyParamReturnUpgrade,
  createCollectionContext,
  getTypeName,
  upgradeObjectMemberFn,
} from "./type-collector.js";

describe("getTypeName", () => {
  describe("primitives", () => {
    it("returns 'string' for strings", () => {
      expect(getTypeName("hello")).toBe("string");
    });

    it("returns 'number' for numbers", () => {
      expect(getTypeName(42)).toBe("number");
      expect(getTypeName(3.14)).toBe("number");
      expect(getTypeName(NaN)).toBe("number");
      expect(getTypeName(Infinity)).toBe("number");
    });

    it("returns 'boolean' for booleans", () => {
      expect(getTypeName(true)).toBe("boolean");
      expect(getTypeName(false)).toBe("boolean");
    });

    it("returns 'undefined' for undefined", () => {
      expect(getTypeName(undefined)).toBe("undefined");
    });

    it("returns 'null' for null", () => {
      expect(getTypeName(null)).toBe("null");
    });

    it("returns 'bigint' for bigints", () => {
      expect(getTypeName(BigInt(42))).toBe("bigint");
    });

    it("returns 'symbol' for symbols", () => {
      expect(getTypeName(Symbol("test"))).toBe("symbol");
    });
  });

  describe("arrays", () => {
    it("returns 'T[]' for homogeneous arrays", () => {
      expect(getTypeName([1, 2, 3])).toBe("number[]");
      expect(getTypeName(["a", "b"])).toBe("string[]");
    });

    it("returns 'Array<T1 | T2>' for heterogeneous arrays", () => {
      expect(getTypeName([1, "two", 3])).toBe("Array<number | string>");
    });

    it("returns 'unknown[]' for empty arrays", () => {
      expect(getTypeName([])).toBe("unknown[]");
    });

    it("deduplicates element types", () => {
      expect(getTypeName([1, 2, 3, 4])).toBe("number[]");
    });

    it("sorts union types alphabetically", () => {
      expect(getTypeName(["a", 1, true])).toBe("Array<boolean | number | string>");
    });
  });

  describe("objects", () => {
    it("returns key-value types for plain objects", () => {
      expect(getTypeName({ name: "Alice", age: 30 })).toBe("{ age: number, name: string }");
    });

    it("returns '{}' for empty objects", () => {
      expect(getTypeName({})).toBe("{}");
    });

    it("sorts keys alphabetically", () => {
      expect(getTypeName({ z: 1, a: 2 })).toBe("{ a: number, z: number }");
    });

    it("escapes special characters in keys", () => {
      expect(getTypeName({ "user-id": 42 })).toBe('{ "user-id": number }');
    });
  });

  describe("functions", () => {
    it("returns function type with unknown for simple functions", () => {
      const fn = function (x: number) {
        return x;
      };
      expect(getTypeName(fn)).toBe("(x: unknown) => unknown");
    });

    it("returns function type with unknown for arrow functions", () => {
      // Params are intentionally untyped from the runtime's perspective —
      // the test is about the synthesized type string, not the body.
      const fn = (a: number, _b: string) => a;
      expect(getTypeName(fn)).toBe("(a: unknown, _b: unknown) => unknown");
    });

    it("returns () => unknown for no-arg functions", () => {
      expect(getTypeName(() => 0)).toBe("() => unknown");
      expect(
        getTypeName(function () {
          return 0;
        }),
      ).toBe("() => unknown");
    });

    it("handles functions where toString fails", () => {
      const fn = () => {};
      const proxy = new Proxy(fn, {
        get(target, prop) {
          if (prop === "toString") throw new Error("no toString");
          return Reflect.get(target, prop);
        },
      });
      expect(getTypeName(proxy)).toBe("Function");
    });

    it("handles callbacks passed as values", () => {
      const callback = (err: Error | null, data: string) => data;
      expect(getTypeName(callback)).toBe("(err: unknown, data: unknown) => unknown");
    });

    it("handles method references", () => {
      class Foo {
        bar(x: number) {
          return x;
        }
      }
      const ref = new Foo().bar;
      expect(getTypeName(ref)).toBe("(x: unknown) => unknown");
    });

    it("detects async functions and returns Promise return type", () => {
      const fn = async (x: number) => x * 2;
      expect(getTypeName(fn)).toBe("(x: unknown) => Promise<unknown>");
    });

    it("detects async functions with block body", () => {
      const fn = async function fetchData(url: string) {
        return url;
      };
      expect(getTypeName(fn)).toBe("(url: unknown) => Promise<unknown>");
    });

    it("detects generator functions", () => {
      function* gen(x: number) {
        yield x;
      }
      expect(getTypeName(gen)).toBe("(x: unknown) => Generator<unknown>");
    });

    it("detects async generator functions", () => {
      async function* gen(x: number) {
        yield x;
      }
      expect(getTypeName(gen)).toBe("(x: unknown) => AsyncGenerator<unknown>");
    });

    it("returns Function for native functions", () => {
      expect(getTypeName(Math.max)).toBe("Function");
      expect(getTypeName(parseInt)).toBe("Function");
    });

    it("handles no-arg async function", () => {
      const fn = async () => 42;
      expect(getTypeName(fn)).toBe("() => Promise<unknown>");
    });

    it("detects class constructors passed as values", () => {
      class MyService {
        constructor(public name: string) {}
      }
      expect(getTypeName(MyService)).toBe("typeof MyService");
    });

    it("detects anonymous class constructors", () => {
      const Klass = class {
        constructor() {}
      };
      expect(getTypeName(Klass)).toBe("typeof Klass");
    });

    it("detects class without explicit constructor", () => {
      class SimpleClass {}
      expect(getTypeName(SimpleClass)).toBe("typeof SimpleClass");
    });

    it("detects bound functions", () => {
      function greet(name: string) {
        return name;
      }
      const bound = greet.bind(null);
      expect(getTypeName(bound)).toBe("(...args: unknown[]) => unknown");
    });

    // Under Vitest+jsdom, walking window can encounter a function
    // whose .toString() returns a CALL expression (no leading
    // `function name(...)` syntax). The arg-extraction regex would
    // then lift the call's argument *values* into parameter-name
    // position. Result is unparseable TypeScript like
    //   (1: unknown, 1014: unknown, "/path/x.ts": unknown) => unknown
    // — bare numerics and quoted strings can't be parameter names.
    // Repro uses an own-property toString override since the natural
    // jsdom trigger is environment-dependent and flaky as a unit test.
    it("falls back to argN when toString yields non-identifier param names", () => {
      const fn = function () {} as unknown as { toString: () => string };
      fn.toString = () => 'something(1, 1014, "/path/x.ts", "{}")';
      const result = getTypeName(fn as unknown as () => unknown);
      expect(result).not.toBeNull();

      const match = result!.match(/^\((.*)\) => /);
      expect(match).not.toBeNull();
      const params = match![1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of params) {
        const [name] = p.split(":").map((s) => s.trim());
        // Allowed forms: regular identifier, ...rest, [a]Array, {a}Object
        expect(name).toMatch(/^(\.\.\.[a-zA-Z_$][\w$]*|[a-zA-Z_$][\w$]*)$/);
      }
    });

    it("skips numeric-only literal param names from mangled toString", () => {
      const fn = function () {} as unknown as { toString: () => string };
      fn.toString = () => "(42, 99) => result";
      const result = getTypeName(fn as unknown as () => unknown);
      // Must not emit `(42: unknown, 99: unknown) => unknown` — invalid TS.
      expect(result).not.toMatch(/\(\s*\d/);
    });
  });

  describe("self-observation skip-list", () => {
    // Under Vitest+jsdom, walking window includes ts-capture's own
    // runtime hooks (__tscptr__ and the __tscptr__* helpers attached to
    // globalThis), polluting observed types with ts-capture-internal
    // symbols. Skip these.
    it("omits __tscptr__ from walked-object types", () => {
      const obj = {
        __tscptr__: function () {},
        realProperty: "hello",
      };
      const result = getTypeName(obj);
      expect(result).not.toContain("__tscptr__");
      expect(result).toContain("realProperty");
    });

    it("omits __tscptr__* helpers from walked-object types", () => {
      const obj = {
        __tscptr__logs: {},
        __tscptr__in_record: false,
        __tscptr__bump: function () {},
        keep: 1,
      };
      const result = getTypeName(obj);
      expect(result).not.toContain("__tscptr__");
      expect(result).toContain("keep");
    });
  });

  describe("class instances", () => {
    it("returns constructor name for class instances", () => {
      class MyService {}
      expect(getTypeName(new MyService())).toBe("MyService");
    });

    it("returns 'Date' for Date instances", () => {
      expect(getTypeName(new Date())).toBe("Date");
    });

    it("returns 'RegExp' for regex", () => {
      expect(getTypeName(/test/)).toBe("RegExp");
    });

    it("returns 'Map' for empty Map instances", () => {
      expect(getTypeName(new Map())).toBe("Map<unknown, unknown>");
    });

    it("returns 'Set' for empty Set instances", () => {
      expect(getTypeName(new Set())).toBe("Set<unknown>");
    });

    // Bare `Promise` (without type args) hits TS2314. ts-capture can't
    // see the resolved value without awaiting (would deform the
    // program), so we emit `Promise<unknown>` — strictly better than
    // bare `Promise` and matches the resolveMapType / resolveSetType
    // pattern.
    it("returns 'Promise<unknown>' for native Promise instances", () => {
      expect(getTypeName(new Promise(() => {}))).toBe("Promise<unknown>");
    });

    it("emits Promise<unknown> even when the Promise is already resolved (cannot peek)", () => {
      expect(getTypeName(Promise.resolve(42))).toBe("Promise<unknown>");
    });

    it("subclass of Promise also emits 'Promise<unknown>' via instanceof match", () => {
      class MyPromise<T> extends Promise<T> {}
      const p = new MyPromise((resolve) => resolve(1));
      expect(getTypeName(p)).toBe("Promise<unknown>");
    });

    // WeakMap / WeakSet can't be iterated at runtime, so we emit
    // default-filled type params.
    it("returns 'WeakMap<object, unknown>' for WeakMap instances", () => {
      expect(getTypeName(new WeakMap())).toBe("WeakMap<object, unknown>");
    });

    it("returns 'WeakSet<object>' for WeakSet instances", () => {
      expect(getTypeName(new WeakSet())).toBe("WeakSet<object>");
    });
  });

  describe("iteration protocols", () => {
    // Pre-fix surface area:
    //   1. Built-in iterators have ctor names with SPACES — "Array
    //      Iterator", "Map Iterator", "Set Iterator". Emitting those
    //      verbatim is invalid TS (the space breaks the identifier).
    //   2. POJO iterables (`{ next, [Symbol.iterator] }`) have
    //      ctorName "Object" and would emit a structural walk of
    //      next/done shape, losing the iteration intent.
    // The fix: detect via Symbol.iterator / Symbol.asyncIterator
    // before the ctorName branch, emit canonical TS lib types.

    it("emits 'IterableIterator<unknown>' for Array iterators", () => {
      const it = [1, 2, 3][Symbol.iterator]();
      expect(getTypeName(it)).toBe("IterableIterator<unknown>");
    });

    it("emits 'IterableIterator<unknown>' for Map iterators", () => {
      const m = new Map([["a", 1]]);
      expect(getTypeName(m.entries())).toBe("IterableIterator<unknown>");
    });

    it("emits 'IterableIterator<unknown>' for Set iterators", () => {
      const s = new Set([1, 2]);
      expect(getTypeName(s.values())).toBe("IterableIterator<unknown>");
    });

    it("emits 'IterableIterator<unknown>' for POJO iterables", () => {
      const pojoIter = {
        next() {
          return { value: 1, done: false };
        },
        [Symbol.iterator]() {
          return this;
        },
      };
      expect(getTypeName(pojoIter)).toBe("IterableIterator<unknown>");
    });

    it("emits 'AsyncIterableIterator<unknown>' for async iterables", () => {
      const asyncIter = {
        async next() {
          return { value: 1, done: false };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      expect(getTypeName(asyncIter)).toBe("AsyncIterableIterator<unknown>");
    });

    it("does not match plain objects without iteration protocol", () => {
      // A regular `{ next: fn }` without Symbol.iterator should
      // emit as a structural walk, not as IterableIterator.
      const plain = { next() {}, value: 1 };
      const result = getTypeName(plain);
      expect(result).not.toBe("IterableIterator<unknown>");
      expect(result).toContain("value: number");
    });

    it("does not override Map / Set / Array branches", () => {
      // Map / Set / Array all carry Symbol.iterator, but the
      // dedicated branches (resolveMapType / resolveSetType /
      // Array.isArray) emit more specific types. The protocol
      // detection must run AFTER those, or skip when ctorName is
      // a TS-valid built-in.
      expect(getTypeName(new Map<string, number>([["a", 1]]))).toBe("Map<string, number>");
      expect(getTypeName(new Set<number>([1, 2]))).toBe("Set<number>");
      expect(getTypeName([1, 2, 3])).toBe("number[]");
    });

    it("emits 'IterableIterator<unknown>' for Generator instances", () => {
      // V8 reports `constructor.name === ""` for generator instances
      // (they inherit from an anonymous Generator prototype), so the
      // bare-ctorName branch can't help — pre-fix the structural walk
      // emitted `{}` (no own properties). Protocol detection via
      // Symbol.iterator handles this correctly. `IterableIterator` is
      // broader than `Generator<T, TReturn, TNext>` but matches what
      // ts-capture can observe without yield/return type info.
      function* gen() {
        yield 1;
      }
      const g = gen();
      expect(getTypeName(g)).toBe("IterableIterator<unknown>");
    });

    it("emits 'AsyncIterableIterator<unknown>' for AsyncGenerator instances", () => {
      // Same as the sync case — V8 doesn't expose a useful ctor name
      // for async generator instances; protocol detection wins.
      async function* gen() {
        yield 1;
      }
      const g = gen();
      expect(getTypeName(g)).toBe("AsyncIterableIterator<unknown>");
    });
  });

  describe("React elements", () => {
    // React tags every element with a $$typeof symbol so it can be
    // distinguished from plain objects. ts-capture must NOT walk such
    // values structurally — the internal `_owner: FiberNode` etc.
    // would leak into apply's emit and get rejected by
    // allTypeRefsInScope (precision that turns out to be un-emittable).

    it("returns 'React.ReactElement' for legacy react.element symbol", () => {
      const element = {
        $$typeof: Symbol.for("react.element"),
        type: "div",
        props: { children: "hello" },
        key: null,
        ref: null,
      };
      expect(getTypeName(element)).toBe("React.ReactElement");
    });

    it("returns 'React.ReactElement' for react.transitional.element (React 19+)", () => {
      const element = {
        $$typeof: Symbol.for("react.transitional.element"),
        type: "div",
        props: {},
        key: null,
      };
      expect(getTypeName(element)).toBe("React.ReactElement");
    });

    it("does not match plain objects with a constructor named FiberNode", () => {
      // A bare class instance named FiberNode (without the $$typeof
      // marker) is unrelated to a React element's internal FiberNode
      // and should still emit by constructor name.
      class FiberNode {}
      expect(getTypeName(new FiberNode())).toBe("FiberNode");
    });

    it("does not match objects with a non-symbol $$typeof", () => {
      // Defensive: only Symbol-valued $$typeof markers match. A string
      // "$$typeof" property is just data — fall through to structural walk.
      const fake = { $$typeof: "react.element", a: 1 };
      const result = getTypeName(fake);
      expect(result).not.toBe("React.ReactElement");
      expect(result).toContain("a: number");
    });

    it("emits 'React.ReactElement' inside a containing object's member type", () => {
      // The typical surfacing: a render-prop callback returns a React
      // element. The containing observation is an object with the
      // element as one of its values. The walk should emit the React
      // type for the element slot without recursing into its internals.
      const element = {
        $$typeof: Symbol.for("react.element"),
        type: "span",
        props: { children: "x" },
        key: null,
      };
      const container = { rendered: element, count: 3 };
      expect(getTypeName(container)).toBe("{ count: number, rendered: React.ReactElement }");
    });
  });

  describe("generic type parameters", () => {
    it("infers Map<K, V> from entries", () => {
      const map = new Map<string, number>([
        ["a", 1],
        ["b", 2],
      ]);
      expect(getTypeName(map)).toBe("Map<string, number>");
    });

    it("infers Map with union key/value types", () => {
      const map = new Map();
      map.set("a", 1);
      map.set(42, "hello");
      expect(getTypeName(map)).toBe("Map<number | string, number | string>");
    });

    it("infers Map with complex value types", () => {
      const map = new Map<string, number[]>();
      map.set("nums", [1, 2, 3]);
      expect(getTypeName(map)).toBe("Map<string, number[]>");
    });

    it("infers Set<T> from values", () => {
      const set = new Set([1, 2, 3]);
      expect(getTypeName(set)).toBe("Set<number>");
    });

    it("infers Set with union types", () => {
      const set = new Set([1, "two", true]);
      expect(getTypeName(set)).toBe("Set<boolean | number | string>");
    });

    it("infers Set with complex element types", () => {
      const set = new Set([
        [1, 2],
        [3, 4],
      ]);
      expect(getTypeName(set)).toBe("Set<number[]>");
    });

    it("infers nested Map and Set", () => {
      const map = new Map<string, Set<number>>();
      map.set("nums", new Set([1, 2]));
      expect(getTypeName(map)).toBe("Map<string, Set<number>>");
    });

    it("handles Map with object values", () => {
      const map = new Map([["user", { name: "Alice", age: 30 }]]);
      expect(getTypeName(map)).toBe("Map<string, { age: number, name: string }>");
    });

    it("respects depth limit for generic contents", () => {
      const map = new Map([["key", { a: { b: { c: 1 } } }]]);
      const result = getTypeName(map, 3);
      expect(result).toContain("Map<");
      expect(result).toContain("unknown");
    });

    it("returns constructor name for non-iterable class instances", () => {
      class MyService {}
      expect(getTypeName(new MyService())).toBe("MyService");
    });

    it("returns constructor name for Date, RegExp, etc.", () => {
      expect(getTypeName(new Date())).toBe("Date");
      expect(getTypeName(/test/)).toBe("RegExp");
    });

    // WeakMap / WeakSet emit default-filled type params
    // (`WeakMap<object, unknown>` / `WeakSet<object>`) so they satisfy
    // TS2314 — bare `WeakMap` / `WeakSet` would be rejected under
    // strict-generic-arity.
    it("handles WeakMap and WeakSet with default type-param fills", () => {
      expect(getTypeName(new WeakMap())).toBe("WeakMap<object, unknown>");
      expect(getTypeName(new WeakSet())).toBe("WeakSet<object>");
    });
  });

  describe("deep nesting", () => {
    it("resolves 5 levels deep with default maxDepth", () => {
      const obj = { a: { b: { c: { d: { e: 42 } } } } };
      const result = getTypeName(obj);
      expect(result).toBe("{ a: { b: { c: { d: { e: unknown } } } } }");
    });

    it("resolves all levels with higher maxDepth", () => {
      const obj = { a: { b: { c: { d: { e: 42 } } } } };
      const result = getTypeName(obj, 10);
      expect(result).toBe("{ a: { b: { c: { d: { e: number } } } } }");
    });

    it("handles arrays nested inside deep objects", () => {
      const obj = { a: { b: { items: [1, 2, 3] } } };
      const result = getTypeName(obj, 10);
      expect(result).toBe("{ a: { b: { items: number[] } } }");
    });

    it("handles objects nested inside arrays", () => {
      const arr = [{ name: "Alice" }, { name: "Bob" }];
      expect(getTypeName(arr)).toBe("{ name: string }[]");
    });

    it("handles Map inside object inside array", () => {
      const arr = [{ cache: new Map([["key", 1]]) }];
      expect(getTypeName(arr, 10)).toBe("{ cache: Map<string, number> }[]");
    });

    it("handles mixed deep nesting with arrays, objects, and generics", () => {
      const data = {
        users: [{ name: "Alice", tags: new Set(["admin"]) }],
      };
      const result = getTypeName(data, 10);
      expect(result).toBe("{ users: { name: string, tags: Set<string> }[] }");
    });
  });

  describe("depth limiting", () => {
    it("truncates nested values to 'unknown' at max depth", () => {
      const deep = { a: { b: { c: 1 } } };
      // depth 0: outer object, depth 1: {b:{c:1}}, depth 2: hit limit
      const result = getTypeName(deep, 2);
      expect(result).toBe("{ a: { b: unknown } }");
    });

    it("returns top-level type even when inner values are truncated", () => {
      const deep = { a: { b: { c: 1 } } };
      const result = getTypeName(deep, 1);
      // depth 0: outer object, depth 1: hit limit → inner value is unknown
      expect(result).toBe("{ a: unknown }");
    });

    it("defaults to depth 5 and handles deep objects", () => {
      // 6 levels deep — innermost truncated, but outer levels resolve
      const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
      const result = getTypeName(deep);
      expect(result).not.toBeNull();
      expect(result).toContain("a:");
      expect(result).toContain("unknown");
    });
  });

  // Wide objects with many shallow properties can produce huge type
  // strings (500KB+ single-line annotations). Depth caps don't help;
  // a size cap on the serialized result does.
  describe("max annotation chars", () => {
    it("plain wide object: falls back to Record<string, unknown> when over budget", () => {
      // 200 keys × ~30 chars each ≈ 6KB > default 4096
      const wide: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) wide[`key_${i}_with_padding_text`] = "string_value";
      const result = getTypeName(wide);
      expect(result).toBe("Record<string, unknown>");
    });

    it("class instance with wide shape: falls back to constructor name", () => {
      class FormControl {
        a = 1;
        b = 2;
      }
      const fc = new FormControl();
      // Inflate the instance with many fields to exceed the 4096-char cap.
      for (let i = 0; i < 200; i++) {
        (fc as unknown as Record<string, unknown>)[`field_${i}_with_padding_text`] = "string_value";
      }
      const result = getTypeName(fc);
      expect(result).toBe("FormControl");
    });

    it("wide-element array: falls back to unknown[]", () => {
      // Single wide element — array dedup keeps one element shape, but
      // the shape itself blows past the budget.
      const wideElem: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) wideElem[`key_${i}_with_padding_text`] = "string_value";
      const arr = [wideElem];
      const result = getTypeName(arr);
      expect(result).toBe("unknown[]");
    });

    it("custom cap can raise the threshold to keep full shape", () => {
      const wide: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) wide[`key_${i}_with_padding_text`] = "string_value";
      // 100K is well above what this wide object produces (~6KB)
      const result = getTypeName(wide, 5, { maxAnnotationChars: 100000 });
      expect(result).not.toBe("Record<string, unknown>");
      expect(result?.length).toBeGreaterThan(4096);
    });

    it("under-budget objects keep their full shape", () => {
      const small = { a: 1, b: "x", c: true };
      const result = getTypeName(small);
      expect(result).toBe("{ a: number, b: string, c: boolean }");
    });
  });
});

describe("CollectionContext", () => {
  let ctx: CollectionContext;

  it("creates an independent context", () => {
    ctx = createCollectionContext();
    expect(ctx).toBeDefined();
    expect(ctx.getCollectedTypes()).toEqual([]);
  });

  it("records a type for a (filename, position) pair", () => {
    ctx = createCollectionContext();
    ctx.record("name", "Alice", 10, "file.ts", {});
    const types = ctx.getCollectedTypes();
    expect(types).toHaveLength(1);
    expect(types[0][0]).toBe("file.ts"); // filename
    expect(types[0][1]).toBe(10); // offset
    expect(types[0][2]).toHaveLength(1); // one observed type
  });

  it("deduplicates repeated observations of the same type", () => {
    ctx = createCollectionContext();
    ctx.record("name", "Alice", 10, "file.ts", {});
    ctx.record("name", "Bob", 10, "file.ts", {});
    ctx.record("name", "Alice", 10, "file.ts", {}); // duplicate string type
    const types = ctx.getCollectedTypes();
    expect(types).toHaveLength(1);
    // Should only have one unique type: "string"
    expect(types[0][2]).toHaveLength(1);
  });

  it("records different types as union members", () => {
    ctx = createCollectionContext();
    ctx.record("val", "hello", 10, "file.ts", {});
    ctx.record("val", 42, 10, "file.ts", {});
    const types = ctx.getCollectedTypes();
    expect(types[0][2]).toHaveLength(2); // string and number
  });

  it("keeps separate entries for different positions", () => {
    ctx = createCollectionContext();
    ctx.record("a", "hello", 10, "file.ts", {});
    ctx.record("b", 42, 20, "file.ts", {});
    const types = ctx.getCollectedTypes();
    expect(types).toHaveLength(2);
  });

  it("keeps separate entries for different files", () => {
    ctx = createCollectionContext();
    ctx.record("a", "hello", 10, "foo.ts", {});
    ctx.record("a", "hello", 10, "bar.ts", {});
    const types = ctx.getCollectedTypes();
    expect(types).toHaveLength(2);
  });

  it("track() returns the value passthrough", () => {
    ctx = createCollectionContext();
    const obj = { x: 1 };
    const result = ctx.track(obj, "file.ts", 5);
    expect(result).toBe(obj);
  });

  it("track() works with primitives (no WeakMap registration)", () => {
    ctx = createCollectionContext();
    expect(ctx.track(42, "file.ts", 5)).toBe(42);
    expect(ctx.track("hello", "file.ts", 5)).toBe("hello");
    expect(ctx.track(null, "file.ts", 5)).toBe(null);
  });

  it("track() registers objects for source tracking", () => {
    ctx = createCollectionContext();
    const obj = { x: 1 };
    ctx.track(obj, "source.ts", 42);
    // Now when we record this object, the source location should be captured
    ctx.record("param", obj, 10, "file.ts", {});
    const types = ctx.getCollectedTypes();
    const [, sourceLocation] = types[0][2][0];
    expect(sourceLocation).toEqual(["source.ts", 42]);
  });

  it("multiple contexts are independent", () => {
    const ctx1 = createCollectionContext();
    const ctx2 = createCollectionContext();
    ctx1.record("a", "hello", 10, "file.ts", {});
    expect(ctx1.getCollectedTypes()).toHaveLength(1);
    expect(ctx2.getCollectedTypes()).toHaveLength(0);
  });

  it("records diagnostics when depth is exceeded", () => {
    ctx = createCollectionContext({ maxDepth: 1 });
    const deep = { a: { b: { c: 1 } } };
    ctx.record("param", deep, 10, "file.ts", {});
    expect(ctx.diagnostics.length).toBeGreaterThan(0);
    expect(ctx.diagnostics[0].type).toBe("depth-exceeded");
  });

  // Observing a Proxy whose get-handler calls __tscptr__ could trigger
  // infinite mutual recursion (RangeError). core's
  // createCollectionContext is protected by getTypeName's
  // typeNameRunning guard, plus a record-level re-entry guard and
  // try/catch as defense-in-depth. This test verifies both layers
  // hold: a Proxy whose get triggers ctx.record on every access must
  // not stack-overflow.
  it("does not stack-overflow when ctx.record observes a recursively-instrumented Proxy", () => {
    const ctx = createCollectionContext();
    const proxy = new Proxy(
      { a: 1, b: 2, c: 3 },
      {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          // Simulate an instrumented get-handler observing its return.
          // Pre-guard, this would recurse via getTypeName → value[k] →
          // Proxy.get → ctx.record → getTypeName → ...
          ctx.record("inner", value, 100, "file.ts", {});
          return value;
        },
      },
    );
    expect(() => ctx.record("outer", proxy, 0, "file.ts", {})).not.toThrow();
    // Outer call recorded; inner calls were no-ops via the re-entry guard
    // (or returned null via getTypeName's typeNameRunning, which the
    // record body now handles by skipping the dedup write).
    expect(ctx.getCollectedTypes().length).toBeGreaterThan(0);
  });

  // Behavior pin for the re-entry guard at the getTypeName boundary
  // (module-level `typeNameRunning`; the walker holds its own, surfaced as
  // WalkResult `{ kind: "reentered" }`). Observable contract: a value whose
  // traversal re-enters getTypeName short-circuits the nested call to null
  // while the outer call returns a normal type. Driven directly, not via
  // ctx.record, to pin the guard at its own boundary.
  it("short-circuits a re-entrant getTypeName call to null (typeNameRunning guard)", () => {
    let nested: string | null = "unset";
    const proxy = new Proxy(
      { a: 1 },
      {
        get(target, prop, receiver) {
          // While the outer getTypeName walk is in progress, a nested call
          // must see the guard tripped and return null rather than recursing.
          if (nested === "unset") nested = getTypeName({ b: 2 });
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const outer = getTypeName(proxy);
    expect(nested).toBeNull();
    expect(outer).not.toBeNull();
    // Guard fully resets: a fresh top-level call after the walk works normally.
    expect(getTypeName({ c: 3 })).toBe("{ c: number }");
  });

  it("honors Symbol.for('ts-capture.peek') — walks the unwrapped value", () => {
    // Plugin protocol (see ROADMAP "Plugin model"). A framework adapter
    // attaches Symbol.for("ts-capture.peek") to its proxies; ts-capture walks
    // the function's return value instead of the proxy facade. Lets us
    // stay framework-agnostic — no Vue/MobX/Solid sigils in core.
    const ctx = createCollectionContext();
    const raw = { foo: 1, bar: "two" };
    const proxyWithPeek = new Proxy(
      {},
      {
        get(target, prop) {
          if (prop === Symbol.for("ts-capture.peek")) return () => raw;
          // We'd reach this path only if peek is ignored; throw so the
          // test fails loudly in that case.
          throw new Error("walked the proxy facade — peek was ignored");
        },
      },
    );
    ctx.record("v", proxyWithPeek, 0, "test.ts", {});
    const collected = ctx.getCollectedTypes();
    expect(collected.length).toBeGreaterThan(0);
    const types = collected[0][2] as Array<[string, unknown]>;
    expect(types[0][0]).toContain("foo:");
    expect(types[0][0]).toContain("bar:");
  });

  it("falls through cleanly when Symbol.for('ts-capture.peek') throws", () => {
    // Defense-in-depth: if a peek() implementation has a bug, we don't
    // want ts-capture to crash — fall back to walking the original value
    // (or its facade). The value here is a plain object with a peek
    // that throws; we expect a normal record + a non-empty type.
    const ctx = createCollectionContext();
    const value: Record<symbol | string, unknown> = { x: 1 };
    value[Symbol.for("ts-capture.peek")] = () => {
      throw new Error("peek bug");
    };
    expect(() => ctx.record("v", value, 0, "test.ts", {})).not.toThrow();
    const collected = ctx.getCollectedTypes();
    expect(collected.length).toBeGreaterThan(0);
  });

  it("does not crash if getTypeName throws on an exotic value", () => {
    const ctx = createCollectionContext();
    // A Proxy whose `ownKeys` throws will crash any walk that calls
    // Object.keys on it. Pre-fix this would propagate up and crash the
    // host program. Post-fix the catch around getTypeName falls back to
    // "unknown" and recording continues.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile getter");
        },
      },
    );
    expect(() => ctx.record("bad", hostile, 0, "file.ts", {})).not.toThrow();
  });
});

describe("circular references", () => {
  it("returns null for self-referencing objects", () => {
    const obj: any = {};
    obj.self = obj;
    const result = getTypeName(obj);
    // Should not hang or produce deeply nested type — the circular value resolves to null
    expect(result).toBe("{ self: unknown }");
  });

  it("returns null for self-referencing arrays", () => {
    const arr: any[] = [];
    arr.push(arr);
    const result = getTypeName(arr);
    // The circular array element resolves to null, filtered out → unknown[]
    expect(result).toBe("unknown[]");
  });

  it("handles indirect circular references", () => {
    const a: any = {};
    a.b = { a };
    const result = getTypeName(a);
    expect(result).not.toBeNull();
    expect(result).toContain("b:");
  });

  it("does not crash on getter-induced reentrancy", () => {
    const obj = {
      get recurse(): any {
        return getTypeName(obj);
      },
    };
    // Getter calls getTypeName reentrantly → returns null (the JS value).
    // resolveType sees null → returns "null" (the string). So the key's type is "null".
    const result = getTypeName(obj);
    expect(result).toBe("{ recurse: null }");
  });
});

describe("additional edge cases", () => {
  describe("arrays", () => {
    it("returns nested array type for arrays of arrays", () => {
      // With no empty arrays, homogeneous → string[][]
      expect(getTypeName([["foo"], ["bar", "baz"]])).toBe("string[][]");
      // Empty arrays produce unknown[] element, creating a union
      expect(getTypeName([["foo"], [], ["bar"]])).toBe("Array<string[] | unknown[]>");
    });
  });

  describe("objects", () => {
    it("infers nested simple objects", () => {
      expect(getTypeName({ foo: { bar: { baz: "hello" } } })).toBe(
        "{ foo: { bar: { baz: string } } }",
      );
    });

    it("infers objects with function values as method-shape", () => {
      // Emits method-shape (`bar(_param: unknown): unknown`) instead
      // of property-shape (`bar: (_param: unknown) => unknown`) so TS
      // treats it as bivariant under --strictFunctionTypes — the
      // dominant variance failure mode on React callback props.
      const result = getTypeName({
        foo: () => 42,
        bar(_param: boolean) {
          return "hello";
        },
      });
      expect(result).toBe("{ bar(_param: unknown): unknown, foo(): unknown }");
    });

    it("infers objects with array values", () => {
      expect(getTypeName({ foo: ["hello", "world"], bar: ["hello", 42] })).toBe(
        "{ bar: Array<number | string>, foo: string[] }",
      );
    });

    it("produces same result regardless of key insertion order", () => {
      const input1 = { a: "hello", b: "world" };
      const input2 = { b: "hello", a: "world" };
      expect(getTypeName(input1)).toBe(getTypeName(input2));
    });
  });

  describe("functions", () => {
    it("returns '() => unknown' for functions without arguments", () => {
      expect(getTypeName(() => 0)).toBe("() => unknown");
      expect(
        getTypeName(function () {
          return 0;
        }),
      ).toBe("() => unknown");
    });

    it("handles functions with default values", () => {
      const fn = (a = 2, b = 3) => a + b;
      const result = getTypeName(fn);
      expect(result).toBe("(a: unknown, b: unknown) => unknown");
    });

    it("handles HOC functions", () => {
      const multByNumberHOC = (multiplier: number) => (num: number) => num * multiplier;
      expect(getTypeName(multByNumberHOC)).toBe("(multiplier: unknown) => unknown");
      const multBy2 = multByNumberHOC(2);
      expect(getTypeName(multBy2)).toBe("(num: unknown) => unknown");
    });

    it("handles array destructured params", () => {
      expect(getTypeName(([a]: number[]) => a)).toBe("(aArray: unknown) => unknown");
    });

    it("handles object destructured params", () => {
      expect(getTypeName(({ a }: { a: number }) => a)).toBe("(aObject: {a: unknown}) => unknown");
    });

    it("handles rest params", () => {
      expect(getTypeName((...a: number[]) => a)).toBe("(...aArray: unknown[]) => unknown");
    });

    // — runtime stringifier emits ungrammatical types
    describe("emit syntactically valid signatures for destructured params", () => {
      it("uses arg0 instead of concatenating many field names (Bug 4a)", () => {
        // Real-world repro: a React Provider component takes
        // `({ children, companySectors, dealCategories, ... })` and the
        // stringifier emitted `childrencompanySectorsdealCategoriesObject`
        // as the param name. The result is an unparseable identifier
        // monster. The fix: switch to a positional anonymous name
        // (`arg0Object`) for any destructured object with >1 field.
        const fn = (({
          children,
          companySectors,
          dealCategories,
        }: {
          children: unknown;
          companySectors: string[];
          dealCategories: string[];
        }) => [children, companySectors, dealCategories]) as Function;
        const result = getTypeName(fn);
        expect(result).not.toMatch(/childrencompanySectors/);
        expect(result).toContain("arg0Object: {");
        expect(result).toContain("children: unknown");
        expect(result).toContain("companySectors: unknown");
        expect(result).toContain("dealCategories: unknown");
      });

      it("handles destructure-rename ({prop: local}) without leaking colons (Bug 4b)", () => {
        // Real-world repro: msw / fakerest handler destructured
        // `({request: e})` (renames `request` → local `e`). The stringifier
        // captured the literal field text `"request: e"` and pushed it
        // through concat AND inner unchanged, producing
        // `(request: eObject: {request: e: unknown}) => unknown` —
        // not parseable TypeScript.
        const fn = (({ request: e }: { request: number }) => e) as Function;
        const result = getTypeName(fn);
        // Must not include the literal "request: e" sequence, which
        // would produce a colon inside both the name and the body.
        expect(result).not.toMatch(/request: e[A-Za-z]/);
        // The local name `e` is what's bound; the body should refer
        // to it (or to `arg0`), not to the source-side `request`.
        expect(result).toMatch(/^\((?:e|arg0)Object: \{e: unknown\}\) => unknown$/);
      });

      it("emits syntactically valid TypeScript for all destructured shapes", () => {
        const cases = [
          ({ a, b }: { a: number; b: number }) => a + b,
          ({ a, b, c }: { a: number; b: number; c: number }) => a + b + c,
          ({ a, ...rest }: { a: number; b: number }) => a + rest.b,
          ({ a: x }: { a: number }) => x,
        ];
        for (const fn of cases) {
          const typeStr = getTypeName(fn as Function);
          const wrapped = `let x: ${typeStr} = null as any;`;
          const sf = ts.createSourceFile("_check.ts", wrapped, ts.ScriptTarget.Latest, false);
          const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
            .parseDiagnostics;
          if (diags && diags.length > 0) {
            throw new Error(
              `Type string did not parse: ${typeStr}\n${diags
                .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
                .join("\n")}`,
            );
          }
        }
      });
    });
  });
});

describe("literal-type opt-in", () => {
  describe("string literals", () => {
    it("emits literal form for short strings when literalString=true", () => {
      expect(getTypeName("hello", 5, { literalString: true })).toBe('"hello"');
    });

    it("emits 'string' for strings longer than literalStringMaxLength", () => {
      const long = "this is a longer than max string";
      expect(getTypeName(long, 5, { literalString: true })).toBe("string");
    });

    it("respects custom literalStringMaxLength", () => {
      const value = "abcd";
      expect(getTypeName(value, 5, { literalString: true, literalStringMaxLength: 3 })).toBe(
        "string",
      );
      expect(getTypeName(value, 5, { literalString: true, literalStringMaxLength: 4 })).toBe(
        '"abcd"',
      );
    });

    it("escapes special characters via JSON.stringify", () => {
      expect(getTypeName('a"b', 5, { literalString: true })).toBe('"a\\"b"');
    });

    it("default behavior (no opts) returns 'string'", () => {
      expect(getTypeName("hello")).toBe("string");
      expect(getTypeName("hello", 5)).toBe("string");
    });
  });

  describe("number literals", () => {
    it("emits literal form when literalNumber=true", () => {
      expect(getTypeName(42, 5, { literalNumber: true })).toBe("42");
      expect(getTypeName(-3.14, 5, { literalNumber: true })).toBe("-3.14");
      expect(getTypeName(0, 5, { literalNumber: true })).toBe("0");
    });

    it("does NOT emit literal form for non-finite numbers (NaN/Infinity not valid TS literals)", () => {
      expect(getTypeName(NaN, 5, { literalNumber: true })).toBe("number");
      expect(getTypeName(Infinity, 5, { literalNumber: true })).toBe("number");
      expect(getTypeName(-Infinity, 5, { literalNumber: true })).toBe("number");
    });

    it("default behavior (no opts) returns 'number'", () => {
      expect(getTypeName(42)).toBe("number");
    });
  });

  describe("boolean literals", () => {
    it("emits literal form when literalBoolean=true", () => {
      expect(getTypeName(true, 5, { literalBoolean: true })).toBe("true");
      expect(getTypeName(false, 5, { literalBoolean: true })).toBe("false");
    });

    it("default behavior (no opts) returns 'boolean'", () => {
      expect(getTypeName(true)).toBe("boolean");
    });
  });

  describe("non-primitive types unaffected by literal opts", () => {
    it("array of numbers still gets number[]", () => {
      expect(getTypeName([1, 2, 3], 5, { literalString: true, literalNumber: false })).toBe(
        "number[]",
      );
    });

    it("inner string IS literalised when traversed under literalString=true", () => {
      expect(getTypeName({ a: "x" }, 5, { literalString: true })).toBe('{ a: "x" }');
    });

    it("null/undefined unchanged", () => {
      expect(getTypeName(null, 5, { literalString: true })).toBe("null");
      expect(getTypeName(undefined, 5, { literalString: true })).toBe("undefined");
    });
  });
});

describe("class hierarchy capture (RewriteMostSpecificCommonBase enablement)", () => {
  it("OFF by default — class instances still emit just the ctor name", () => {
    class Animal {}
    class Mammal extends Animal {}
    class Cat extends Mammal {}
    expect(getTypeName(new Cat())).toBe("Cat");
  });

  it("ON — encodes the prototype chain inline as `@sa:` marker comment", () => {
    class Animal {}
    class Mammal extends Animal {}
    class Cat extends Mammal {}
    expect(getTypeName(new Cat(), 5, { captureClassHierarchy: true })).toBe(
      "Cat /* @sa:Mammal|Animal */",
    );
  });

  it("ON — class with no non-Object ancestor emits empty chain marker", () => {
    // The empty `@sa:` marker is the signal that this is still a class
    // observation (vs. a plain primitive). Apply uses the marker to
    // distinguish "class with empty chain" from "non-class type string".
    class Standalone {}
    expect(getTypeName(new Standalone(), 5, { captureClassHierarchy: true })).toBe(
      "Standalone /* @sa: */",
    );
  });

  it("ON — built-in Error subclasses include `Error` in chain", () => {
    class CustomError extends Error {}
    expect(getTypeName(new CustomError("x"), 5, { captureClassHierarchy: true })).toBe(
      "CustomError /* @sa:Error */",
    );
  });

  it("ON — Map/Set still take their existing precedence over chain capture", () => {
    // Map/Set are intercepted before the ctor-name branch via instanceof
    // checks. A subclass of Map currently goes through resolveMapType
    // and loses its more-specific name — known limitation, behaviour
    // unchanged by chain capture.
    expect(getTypeName(new Map(), 5, { captureClassHierarchy: true })).toBe(
      "Map<unknown, unknown>",
    );
  });

  it("ON — primitives are unaffected (no marker added)", () => {
    expect(getTypeName("hello", 5, { captureClassHierarchy: true })).toBe("string");
    expect(getTypeName(42, 5, { captureClassHierarchy: true })).toBe("number");
    expect(getTypeName(true, 5, { captureClassHierarchy: true })).toBe("boolean");
    expect(getTypeName(null, 5, { captureClassHierarchy: true })).toBe("null");
  });

  it("ON — truly-nameless ancestor links are skipped from the chain", () => {
    class Base {}
    // Use a class returned from a factory call so V8 can't infer a
    // variable-assignment name. constructor.name is "" for the
    // intermediate, so the chain walker should skip that link.
    function makeMixin<T extends new (...a: any[]) => any>(B: T) {
      return class extends B {};
    }
    const Mixed = makeMixin(Base);
    class Top extends Mixed {}
    expect(getTypeName(new Top(), 5, { captureClassHierarchy: true })).toBe("Top /* @sa:Base */");
  });

  it("ON — chain marker appears inside object value position when traversed", () => {
    // resolveObjectType walks each value through resolveType, which
    // honours the same captureClassHierarchy flag. The marker becomes
    // part of the inner type string and apply will strip it later.
    class Animal {}
    class Cat extends Animal {}
    const obj = { pet: new Cat() };
    expect(getTypeName(obj, 5, { captureClassHierarchy: true })).toBe(
      "{ pet: Cat /* @sa:Animal */ }",
    );
  });
});

// Function-valued object members emit as method-shape, not
// property-shape, so TS's --strictFunctionTypes treats them as
// bivariant in parameter types. The dominant TS2322 failure mode is
// `(t: string) => JSX.Element` failing to assign to
// `render: (t: unknown) => unknown` because contravariance rejects
// passing a narrower-param-typed callback. Method-shape
// (`render(t: unknown): unknown`) gets bivariant treatment and
// accepts the narrower callsite type.
describe("function-valued object members emit as method-shape", () => {
  it("single function prop becomes a method", () => {
    const result = getTypeName({ onClick: (_e: unknown) => undefined });
    expect(result).toBe("{ onClick(_e: unknown): unknown }");
  });

  it("multiple function props all become methods", () => {
    const result = getTypeName({
      onClick: (_e: unknown) => undefined,
      onChange: (_v: unknown) => undefined,
      onBlur: () => undefined,
    });
    expect(result).toBe(
      "{ onBlur(): unknown, onChange(_v: unknown): unknown, onClick(_e: unknown): unknown }",
    );
  });

  it("function with multiple params: all preserved in method signature", () => {
    const result = getTypeName({
      onSelect: (_item: unknown, _idx: unknown) => undefined,
    });
    expect(result).toBe("{ onSelect(_item: unknown, _idx: unknown): unknown }");
  });

  it("mix of function and non-function values", () => {
    // Functions get method-shape, primitives stay property-shape.
    const result = getTypeName({
      name: "Foo",
      onClick: (_e: unknown) => undefined,
      count: 42,
    });
    expect(result).toBe("{ count: number, name: string, onClick(_e: unknown): unknown }");
  });

  it("class-instance member: callable method also emits method-shape", () => {
    class Form {
      submit(_data: unknown): undefined {
        return undefined;
      }
    }
    // The Form instance has submit as a method. When walked as an
    // object value (not a class instance reference), method-shape
    // applies to submit too.
    const fakeFormShape = { submit: (_data: unknown) => undefined };
    const result = getTypeName(fakeFormShape);
    expect(result).toBe("{ submit(_data: unknown): unknown }");
    void new Form(); // touch Form so TS doesn't complain about unused class
  });
});

describe("upgradeObjectMemberFn", () => {
  it("upgrades a single method-shape member", () => {
    expect(
      upgradeObjectMemberFn(
        "{ render(x: unknown): unknown, title: string }",
        "render",
        "(x: number) => string",
      ),
    ).toBe("{ render(x: number): string, title: string }");
  });

  it("upgrades the last member (no trailing comma)", () => {
    expect(
      upgradeObjectMemberFn("{ render(x: unknown): unknown }", "render", "(x: number) => string"),
    ).toBe("{ render(x: number): string }");
  });

  it("upgrades when return type is a nested object", () => {
    expect(
      upgradeObjectMemberFn(
        "{ fn(x: unknown): unknown, name: string }",
        "fn",
        "(x: number) => { a: string, b: number }",
      ),
    ).toBe("{ fn(x: number): { a: string, b: number }, name: string }");
  });

  it("upgrades when args contain nested parens (callback arg type)", () => {
    expect(
      upgradeObjectMemberFn(
        "{ fn(cb: unknown): unknown }",
        "fn",
        "(cb: (x: number) => void) => boolean",
      ),
    ).toBe("{ fn(cb: (x: number) => void): boolean }");
  });

  it("upgrades all matching members when called sequentially", () => {
    let result = "{ a(x: unknown): unknown, b(y: unknown): unknown }";
    result = upgradeObjectMemberFn(result, "a", "(x: string) => number");
    result = upgradeObjectMemberFn(result, "b", "(y: boolean) => void");
    expect(result).toBe("{ a(x: string): number, b(y: boolean): void }");
  });

  it("returns the original string when member is not found", () => {
    const original = "{ title: string }";
    expect(upgradeObjectMemberFn(original, "missing", "(x: number) => void")).toBe(original);
  });

  it("returns the original string when sig is not a function arrow", () => {
    const original = "{ render(x: unknown): unknown }";
    expect(upgradeObjectMemberFn(original, "render", "string")).toBe(original);
  });
});

describe("applyParamReturnUpgrade", () => {
  it("substitutes the trailing unknown of a top-level function arrow", () => {
    expect(applyParamReturnUpgrade("(x: unknown) => unknown", "cb", ["number"])).toBe(
      "(x: unknown) => number",
    );
  });

  it("substitutes the return type of an object member", () => {
    expect(
      applyParamReturnUpgrade("{ render(t: unknown): unknown, title: string }", "render", [
        "string",
      ]),
    ).toBe("{ render(t: unknown): string, title: string }");
  });

  it("unions multiple observed return types deterministically", () => {
    expect(
      applyParamReturnUpgrade("(x: unknown) => unknown", "cb", ["number", "string", "number"]),
    ).toBe("(x: unknown) => number | string");
  });

  it("leaves a specific (non-unknown) existing return alone — fallback only", () => {
    // Parent's cross-ref already gave us a real signature. Param-return is a
    // fallback, not an override: trust the parent's specific return.
    const already = "{ render(t: string): JSX.Element, title: string }";
    expect(applyParamReturnUpgrade(already, "render", ["null"])).toBe(already);
  });

  it("leaves a specific top-level return alone", () => {
    const already = "(x: number) => string";
    expect(applyParamReturnUpgrade(already, "cb", ["null"])).toBe(already);
  });

  it("returns the input unchanged when member not found", () => {
    const orig = "{ title: string }";
    expect(applyParamReturnUpgrade(orig, "render", ["string"])).toBe(orig);
  });

  it("returns the input unchanged when observed types are empty", () => {
    const orig = "(x: unknown) => unknown";
    expect(applyParamReturnUpgrade(orig, "cb", [])).toBe(orig);
  });

  it("handles object members where args contain nested parens", () => {
    expect(
      applyParamReturnUpgrade("{ fn(cb: (x: number) => void): unknown }", "fn", ["boolean"]),
    ).toBe("{ fn(cb: (x: number) => void): boolean }");
  });
});
