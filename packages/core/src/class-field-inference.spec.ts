import { describe, expect, it } from "vitest";

import type { CollectedTypeInfo } from "./type-collector.js";

import { inferClassFieldTypes } from "./class-field-inference.js";

// Direct specs for the offset-applier's class-field inference. Previously reachable
// only through a full applyTypesToFile round-trip; now a pure
// (source, typeInfo) → synthetic-entries unit.

/** Observation entry at a given offset carrying one observed type. */
const obs = (file: string, pos: number, type: string): CollectedTypeInfo[number] => [
  file,
  pos,
  [[type, undefined]],
  {},
];

describe("inferClassFieldTypes", () => {
  it("propagates a constructor-param type to a `this.field = param` declaration", () => {
    const src = "class Counter {\n  count;\n  constructor(initial) { this.count = initial; }\n}";
    // Observation for `initial` at its name.end.
    const pos = src.indexOf("initial)") + "initial".length;
    const synthetic = inferClassFieldTypes(src, [obs("f.ts", pos, "number")]);
    expect(synthetic).toHaveLength(1);
    const [file, fieldPos, types] = synthetic[0];
    expect(file).toBe("f.ts");
    expect(fieldPos).toBe(src.indexOf("count;") + "count".length);
    expect(types[0][0]).toBe("number");
  });

  it("prefers the param's source-declared type over observations", () => {
    const src = "class C {\n  x;\n  constructor(a: string) { this.x = a; }\n}";
    // Even with a (conflicting) observation, the declared `: string` wins.
    const pos = src.indexOf("a:") + 1;
    const synthetic = inferClassFieldTypes(src, [obs("f.ts", pos, "number")]);
    expect(synthetic[0][2][0][0]).toBe("string");
  });

  it("skips fields that already have a type or an initializer", () => {
    const typed = "class C {\n  x: number;\n  constructor(a) { this.x = a; }\n}";
    const initialized = "class C {\n  x = 0;\n  constructor(a) { this.x = a; }\n}";
    const pos = (s: string) => s.indexOf("(a)") + 2;
    expect(inferClassFieldTypes(typed, [obs("f.ts", pos(typed), "number")])).toHaveLength(0);
    expect(
      inferClassFieldTypes(initialized, [obs("f.ts", pos(initialized), "number")]),
    ).toHaveLength(0);
  });

  it("emits nothing when there is no observation for the assigned param", () => {
    const src = "class C {\n  x;\n  constructor(a) { this.x = a; }\n}";
    expect(inferClassFieldTypes(src, [])).toHaveLength(0);
  });
});
