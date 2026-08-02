import { describe, expect, it } from "vitest";

import { recognizeBuiltinShape } from "./builtin-shape.js";
import { parseType, serializeType } from "./type-ir.js";

/**
 * Recognize structural fingerprints of common built-ins
 * and rewrite to named refs. Each test exercises one shape positively
 * (real Promise-shape → `Promise<unknown>`) and confirms a near-miss
 * (object missing a required key) stays as-is.
 */

function recognize(s: string): string | null {
  const node = parseType(s);
  const rewritten = recognizeBuiltinShape(node);
  return rewritten === null ? null : serializeType(rewritten);
}

describe("builtin-shape — recognizer", () => {
  it("recognises Promise structural shape → Promise<unknown>", () => {
    expect(recognize("{ then: (cb: unknown) => unknown, catch: (cb: unknown) => unknown }")).toBe(
      "Promise<unknown>",
    );
  });

  it("Promise-like without `catch` is not recognised", () => {
    expect(recognize("{ then: (cb: unknown) => unknown }")).toBeNull();
  });

  it("recognises Map structural shape → Map<unknown, unknown>", () => {
    expect(
      recognize(
        "{ get: (k: unknown) => unknown, set: (k: unknown, v: unknown) => unknown, has: (k: unknown) => unknown, delete: (k: unknown) => unknown, size: number }",
      ),
    ).toBe("Map<unknown, unknown>");
  });

  it("Map-like missing `size` is not recognised", () => {
    expect(
      recognize(
        "{ get: (k: unknown) => unknown, set: (k: unknown, v: unknown) => unknown, has: (k: unknown) => unknown, delete: (k: unknown) => unknown }",
      ),
    ).toBeNull();
  });

  it("recognises Set structural shape → Set<unknown>", () => {
    expect(
      recognize(
        "{ add: (v: unknown) => unknown, has: (v: unknown) => unknown, delete: (v: unknown) => unknown, size: number }",
      ),
    ).toBe("Set<unknown>");
  });

  it("Set-shape missing `add` is not recognised", () => {
    expect(
      recognize("{ has: (v: unknown) => unknown, delete: (v: unknown) => unknown, size: number }"),
    ).toBeNull();
  });

  it("recognises Date structural shape → Date", () => {
    expect(
      recognize("{ getTime: () => number, getFullYear: () => number, toISOString: () => string }"),
    ).toBe("Date");
  });

  it("Date-like missing toISOString not recognised", () => {
    expect(recognize("{ getTime: () => number, getFullYear: () => number }")).toBeNull();
  });

  it("recognises RegExp structural shape → RegExp", () => {
    expect(
      recognize(
        "{ test: (s: unknown) => boolean, exec: (s: unknown) => unknown, source: string, flags: string }",
      ),
    ).toBe("RegExp");
  });

  it("RegExp-like missing `source` not recognised", () => {
    expect(
      recognize("{ test: (s: unknown) => boolean, exec: (s: unknown) => unknown, flags: string }"),
    ).toBeNull();
  });

  it("recognises Error structural shape → Error", () => {
    expect(recognize("{ name: string, message: string, stack: string }")).toBe("Error");
  });

  it("Error-like missing stack not recognised", () => {
    expect(recognize("{ name: string, message: string }")).toBeNull();
  });

  it("recognises Promise even when extra keys present", () => {
    // Real Promise instances have `then`, `catch`, `finally`, and
    // possibly Symbol-named keys. Extra keys must not block the match —
    // the fingerprint is "at least these keys", not "exactly these".
    expect(
      recognize(
        "{ then: (cb: unknown) => unknown, catch: (cb: unknown) => unknown, finally: (cb: unknown) => unknown }",
      ),
    ).toBe("Promise<unknown>");
  });

  it("non-object types pass through", () => {
    expect(recognize("string")).toBeNull();
    expect(recognize("Promise<string>")).toBeNull(); // already a ref, no rewrite needed
    expect(recognize("string[]")).toBeNull();
  });

  it("object with required key as optional does NOT match", () => {
    // `then?: (cb) => unknown` is in `optional`, not `required` — not a Promise.
    expect(
      recognize("{ then?: (cb: unknown) => unknown, catch: (cb: unknown) => unknown }"),
    ).toBeNull();
  });
});
