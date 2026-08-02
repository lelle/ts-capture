import { describe, expect, it } from "vitest";

import type { DiscoveredType } from "./collector-contract.js";
import type { ExtraOptions } from "./type-collector.js";

import { computeAnnotationTypeString } from "./compute-annotation.js";
import { INFER_DEFAULTS, type InferOptions } from "./configuration.js";

// Boundary spec for the shared annotation core. computeAnnotationTypeString is
// the orchestrator both appliers call; it had no dedicated spec (only the
// 4,604-line apply-types.spec.ts). These tests pin the COMPOSITION seams — what
// it does around mergeTypes (returnType shaping, optional strip, useless-arrow
// suppression, unknown[] filters, the length cap, findType fallback) — not the
// merge algebra itself, which type-merge.spec.ts owns.

function run(
  types: DiscoveredType[],
  opts: ExtraOptions,
  isOptionalBinding = false,
  infer: InferOptions = INFER_DEFAULTS,
): string | null {
  return computeAnnotationTypeString(types, opts, infer, isOptionalBinding);
}

describe("computeAnnotationTypeString — resolution & empties", () => {
  it("falls back to the observed name when no program is supplied", () => {
    expect(run([["MyType", undefined]], {})).toBe("MyType");
  });

  it("returns null for an empty observation vector", () => {
    expect(run([], {})).toBeNull();
  });
});

describe("computeAnnotationTypeString — return-type shaping", () => {
  it("widens a sole-undefined return to void", () => {
    expect(run([["undefined", undefined]], { returnType: true })).toBe("void");
  });

  it("wraps an async return type in Promise<>", () => {
    expect(run([["string", undefined]], { returnType: true, async: true })).toBe("Promise<string>");
  });

  it("unwraps an inner Promise before re-wrapping async (no Promise<Promise<>>)", () => {
    expect(run([["Promise<number>", undefined]], { returnType: true, async: true })).toBe(
      "Promise<number>",
    );
  });

  // Migrated from apply-types.spec.ts's "returnType undefined widens to void"
  // and "async function returning Promise doesn't double-wrap" blocks.
  it("keeps undefined in a return-type union (only a sole-undefined widens to void)", () => {
    expect(
      run(
        [
          ["number", undefined],
          ["undefined", undefined],
        ],
        { returnType: true },
      ),
    ).toBe("number|undefined");
  });

  it("widens a sole-undefined async return to Promise<void> (not Promise<undefined>)", () => {
    expect(run([["undefined", undefined]], { returnType: true, async: true })).toBe(
      "Promise<void>",
    );
  });

  it("does not void-widen a sole-undefined that is not a return type", () => {
    expect(run([["undefined", undefined]], { varDecl: true })).toBe("undefined");
  });

  it("unwraps each branch of a Promise union before wrapping async once", () => {
    expect(
      run(
        [
          ["Promise<string>", undefined],
          ["Promise<number>", undefined],
        ],
        {
          returnType: true,
          async: true,
        },
      ),
    ).toBe("Promise<number | string>");
  });

  it("unwraps the Promise side of a mixed Promise<T> | U async return", () => {
    expect(
      run(
        [
          ["Promise<number>", undefined],
          ["string", undefined],
        ],
        {
          returnType: true,
          async: true,
        },
      ),
    ).toBe("Promise<number | string>");
  });
});

describe("computeAnnotationTypeString — optional-binding undefined strip", () => {
  const types: DiscoveredType[] = [
    ["string", undefined],
    ["undefined", undefined],
  ];

  it("drops undefined from an optional binding's union", () => {
    expect(run(types, {}, true)).toBe("string");
  });

  it("keeps undefined when the binding is not optional", () => {
    expect(run(types, {}, false)).toBe("string|undefined");
  });
});

describe("computeAnnotationTypeString — useless-arrow suppression", () => {
  const arrow: DiscoveredType[] = [["(arg: unknown) => unknown", undefined]];

  it("suppresses a sole useless-arrow observation", () => {
    expect(run(arrow, {})).toBeNull();
  });

  it("preserves the useless arrow in diagnostic mode", () => {
    expect(run(arrow, {}, false, { ...INFER_DEFAULTS, emitDiagnosticComments: true })).toBe(
      "(arg: unknown) => unknown",
    );
  });

  // Migrated from apply-types.spec.ts's "useless-arrow suppression on varDecl"
  // block. Suppression fires only when the SOLE observation is all-unknown; a
  // concrete param/return, or a useful type alongside it, keeps the annotation.
  it("suppresses a sole rest-arg useless arrow", () => {
    expect(run([["(...args: unknown[]) => unknown", undefined]], {})).toBeNull();
  });

  it("keeps an arrow with a non-unknown parameter", () => {
    expect(run([["(arg: string) => unknown", undefined]], {})).toBe("(arg: string) => unknown");
  });

  it("keeps an arrow with a non-unknown return", () => {
    expect(run([["(arg: unknown) => string", undefined]], {})).toBe("(arg: unknown) => string");
  });

  it("keeps the union when a useless arrow appears alongside a useful type", () => {
    expect(
      run(
        [
          ["(arg: unknown) => unknown", undefined],
          ["string", undefined],
        ],
        {},
      ),
    ).toBe("(arg: unknown) => unknown|string");
  });
});

describe("computeAnnotationTypeString — unknown[] union collapse", () => {
  // Migrated from apply-types.spec.ts's "unknown[] collapse in array-union
  // output" block. `unknown[]` is the inferred type of an empty-array
  // observation; it is dropped from a union when a concrete array type is also
  // present (it adds no information), but kept when it stands alone or is paired
  // with a non-array. (varDecl vs not makes no difference at this boundary.)
  it("drops unknown[] when a concrete T[] is present", () => {
    expect(
      run(
        [
          ["unknown[]", undefined],
          ["string[]", undefined],
        ],
        {},
      ),
    ).toBe("string[]");
  });

  it("drops unknown[] when an Array<T> form is present", () => {
    expect(
      run(
        [
          ["unknown[]", undefined],
          ["Array<string | number>", undefined],
        ],
        {},
      ),
    ).toBe("Array<string | number>");
  });

  it("keeps unknown[] when it is the only observation", () => {
    expect(run([["unknown[]", undefined]], {})).toBe("unknown[]");
  });

  it("keeps unknown[] when paired with a non-array type", () => {
    expect(
      run(
        [
          ["unknown[]", undefined],
          ["string", undefined],
        ],
        {},
      ),
    ).toBe("string|unknown[]");
  });

  it("preserves a T[] | U[] union that has no unknown[] (regression)", () => {
    expect(
      run(
        [
          ["string[]", undefined],
          ["number[]", undefined],
        ],
        {},
      ),
    ).toBe("number[]|string[]");
  });
});

describe("computeAnnotationTypeString — suppress object-shape with unknown[] field", () => {
  // Migrated from apply-types.spec.ts's "suppress object-shape with unknown[]
  // field" block. An object whose field is `unknown[]` would lock an
  // information-losing type into source, so the whole annotation is dropped
  // (returns null). The guard is field-specific: a standalone unknown[] and an
  // `unknown[]` used as a function parameter are left alone.
  it("drops the annotation when a field's value is unknown[] (minimal)", () => {
    expect(run([["{ a: unknown[] }", undefined]], {})).toBeNull();
  });

  it("drops the annotation when a field's value is unknown[]", () => {
    expect(
      run([["{ outline: unknown[], primary: string[], white: string[] }", undefined]], {}),
    ).toBeNull();
  });

  it("drops the annotation when a nested object field is unknown[]", () => {
    expect(run([["{ a: string, nested: { items: unknown[] } }", undefined]], {})).toBeNull();
  });

  it("keeps the annotation when no field is unknown[]", () => {
    expect(run([["{ a: string, b: number[] }", undefined]], {})).toBe("{ a: string, b: number[] }");
  });

  it("keeps a standalone unknown[] (not an object field)", () => {
    expect(run([["unknown[]", undefined]], {})).toBe("unknown[]");
  });

  it("does not match unknown[] inside a function-parameter type", () => {
    expect(run([["{ fn: (x: unknown[]) => void }", undefined]], {})).toBe(
      "{ fn: (x: unknown[]) => void }",
    );
  });
});

describe("computeAnnotationTypeString — length cap", () => {
  // Migrated from apply-types.spec.ts's "maxAnnotationChars cap" block. An
  // annotation longer than the cap is dropped (null) — except a class-union
  // carrying @sa chain markers, which falls back to its most-specific common
  // base as a last resort (this fallback fires regardless of rewriteCommonBase).
  function makeLongShape(fields: number): string {
    const pairs = Array.from({ length: fields }, (_, i) => `k${i}: string`);
    return `{ ${pairs.join(", ")} }`;
  }
  const saClasses: DiscoveredType[] = Array.from({ length: 20 }, (_, i) => [
    `LongClassNameNumber${i} /* @sa:Mammal|Animal */`,
    undefined,
  ]);

  it("suppresses an annotation that exceeds maxAnnotationChars", () => {
    expect(
      run([["{ aaa: number }", undefined]], {}, false, {
        ...INFER_DEFAULTS,
        maxAnnotationChars: 5,
      }),
    ).toBeNull();
  });

  it("drops a shape that exceeds the default 4096 cap", () => {
    expect(run([[makeLongShape(500), undefined]], { varDecl: true })).toBeNull();
  });

  it("preserves a shape that fits under the default cap", () => {
    const modest = makeLongShape(30);
    expect(run([[modest, undefined]], { varDecl: true })).toBe(modest);
  });

  it("honors a user-configured tighter cap", () => {
    expect(
      run([[makeLongShape(60), undefined]], { varDecl: true }, false, {
        ...INFER_DEFAULTS,
        maxAnnotationChars: 500,
      }),
    ).toBeNull();
  });

  it("falls back to the common base when a class-union exceeds the cap", () => {
    expect(
      run(saClasses, { varDecl: true }, false, { ...INFER_DEFAULTS, maxAnnotationChars: 100 }),
    ).toBe("Mammal");
  });

  it("fires the common-base fallback even when rewriteCommonBase is off", () => {
    expect(
      run(saClasses, { varDecl: true }, false, {
        ...INFER_DEFAULTS,
        maxAnnotationChars: 100,
        rewriteCommonBase: false,
      }),
    ).toBe("Mammal");
  });

  it("still drops an over-cap union with no @sa chain info to collapse", () => {
    expect(run([[makeLongShape(500), undefined]], { varDecl: true })).toBeNull();
  });
});
