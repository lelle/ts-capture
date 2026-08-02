import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { DiscoveredType } from "./collector-contract.js";
import type { CollectedTypeEntry, CollectedTypeInfo, SourceLocation } from "./type-collector.js";

import { applyTypesToFile } from "./apply-types.js";
import { INFER_DEFAULTS } from "./configuration.js";
import { newApplyTelemetry } from "./contract.js";

type LooseTypeTuple =
  [string | undefined] | [string | undefined, SourceLocation | undefined] | DiscoveredType;

// Helper: create a type info entry for a single param observation.
// Accepts loose 1/2/3-tuple inputs and pads to the canonical 3-tuple shape
// so call sites can keep using `[["string"]]` without per-test boilerplate.
function entry(
  filename: string,
  offset: number,
  types: Array<LooseTypeTuple>,
  opts = {},
): CollectedTypeEntry {
  const normalized = types.map((t): DiscoveredType => [t[0], t[1] ?? undefined, t[2]]);
  return [filename, offset, normalized, opts];
}

describe("applyTypesToFile", () => {
  it("inserts a single type annotation", () => {
    // function foo(a) {}
    //               ^14
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: string) {}");
  });

  it("inserts annotations for multiple parameters", () => {
    // function foo(a, b) {}
    //               ^14  ^17
    const source = "function foo(a, b) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["number"]]),
      entry("test.ts", 17, [["string"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: number, b: string) {}");
  });

  it("creates union types from multiple observations", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"], ["number"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: number|string) {}");
  });

  it("deduplicates repeated type observations", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["string"], ["string"], ["number"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: number|string) {}");
  });

  it("removes 'undefined' from optional parameter types", () => {
    // function foo(a?) {}
    //               ^14, ? at 14, so pos is 15
    const source = "function foo(a?) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 15, [["number"], ["undefined"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a?: number) {}");
  });

  it("skips entry when all types are undefined for optional param", () => {
    const source = "function foo(a?) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 15, [["undefined"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a?) {}");
  });

  it("skips entry when no types observed", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a) {}");
  });

  it("skips entry with only null/undefined type names", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [[undefined]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a) {}");
  });

  it("adds prefix before type when configured", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];
    const result = applyTypesToFile(source, typeInfo, { prefix: "/*auto*/" });
    expect(result).toBe("function foo(a: /*auto*/string) {}");
  });

  it("handles arrow function parens option", () => {
    // x => x + 1  (no parens originally)
    // parens: [0, 1] means wrap param range with ()
    const source = "x => x + 1";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 1, [["number"]], { arrow: true, parens: [0, 1] }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("(x: number) => x + 1");
  });

  it("handles thisType option", () => {
    const source = "function greet() { return this.text; }";
    // parameters.pos is right after '('  => offset 15
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 15, [["Date"]], { thisType: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function greet(this: Date) { return this.text; }");
  });

  it("handles thisNeedsComma with existing params", () => {
    const source = "function greet(name) { return this.text + name; }";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 15, [["Date"]], { thisType: true, thisNeedsComma: true }),
      entry("test.ts", 19, [["string"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function greet(this: Date, name: string) { return this.text + name; }");
  });

  it("returns source unchanged for empty type info", () => {
    const source = "function foo(a) {}";
    const result = applyTypesToFile(source, [], {});
    expect(result).toBe("function foo(a) {}");
  });

  it("filters type info to only entries matching the file", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("other.ts", 14, [["number"]]),
      entry("test.ts", 14, [["string"]]),
    ];
    // applyTypesToFile processes all entries — caller is responsible for filtering
    // But entries for other files will insert at wrong positions; the batch function handles grouping
    // For this test, only pass matching entries
    const filtered = typeInfo.filter(([f]) => f === "test.ts");
    const result = applyTypesToFile(source, filtered, {});
    expect(result).toBe("function foo(a: string) {}");
  });
});

describe("merging object types for optional properties", () => {
  // One end-to-end sample proving a merged object reaches the inserted
  // annotation. The merge-algebra variations live in `type-merge.spec.ts`
  // ("mergeTypes — object-merge variations"), tested against mergeTypes directly.
  it("merges two object types with overlapping keys into one with optional properties", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["{ age: number, name: string }"], ["{ name: string }"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: { age?: number, name: string }) {}");
  });
});

describe("discriminated union detection (applier wiring)", () => {
  // The mergeTypes discriminator / recursive-merge / literal / cross-sample
  // array algebra is unit-tested at the boundary in type-merge.spec.ts. These
  // end-to-end samples prove the applier wires that algebra through the full
  // pipeline — collapseLiteral, scope / annotation emit, and the final sorted
  // union join.
  it("merges through when no shared-key value is a literal", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [
        ["{ kind: number, value: number }"],
        ["{ kind: string, items: string[] }"],
      ]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(
      "function foo(a: { items?: string[], kind: number | string, value?: number }) {}",
    );
  });

  it("bails to a flat union when a shared key has literal types", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [['{ kind: "a", value: number }'], ['{ kind: "b", items: string[] }']]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: {
        ...INFER_DEFAULTS,
        requireTypeRefInScope: false,
        literal: { ...INFER_DEFAULTS.literal, string: true },
      },
    });
    expect(result).toBe(
      'function foo(a: { kind: "a", value: number }|{ kind: "b", items: string[] }) {}',
    );
  });

  it("recursively merges nested object values end-to-end", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["{ config: { value: string } }"], ["{ config: { value: number } }"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: { config: { value: number | string } }) {}");
  });

  it("widens nested literals through the in-pipeline collapse", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [['{ a: "yes", b: 42, c: true }']])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: { a: string, b: number, c: boolean }) {}");
  });

  it("sorts the final union when a cross-sample array merges beside a non-array", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["number[]"], ["string[]"], ["boolean"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, crossSampleArrayMerge: true },
    });
    expect(result).toBe("function foo(a: Array<number | string>|boolean) {}");
  });
});

describe("applyTypesToFile — outer-annotation skip on typed-RHS var declarations (applier wiring)", () => {
  // The function-expression-RHS detection (across const-arrow, function-expr,
  // and class-field PropertyDeclaration) is unit-tested at the boundary in
  // skip-sets.spec.ts (buildOuterAnnotationSkipSet); the drop decision in
  // annotation-eligibility.spec.ts (decideVarDeclSite). These e2e samples prove
  // the applier wiring: an outer annotation is skipped on a function RHS (it
  // would contravariantly conflict with the typed RHS / inner observations),
  // still emitted for a non-function RHS, and the skip does not block
  // inner-position observations.
  it("skips the outer annotation when the RHS is a function expression", () => {
    const source = "const fullyTyped = (name: string): string => name;";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 16, [["(name: unknown) => unknown"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source); // unchanged
  });

  it("STILL adds the outer annotation for a non-function RHS value", () => {
    const source = "const count = 42;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 11, [["number"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("const count: number = 42;");
  });

  it("skips the outer annotation but still applies an inner-position observation", () => {
    // pos 7 = right after "f"; pos 12 = right after "n"
    const source = "const f = (n) => n + 1;";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 7, [["(n: unknown) => unknown"]], { varDecl: true }),
      entry("test.ts", 12, [["number"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("const f = (n: number) => n + 1;");
  });

  it("skips the outer annotation for a class-field arrow (PropertyDeclaration)", () => {
    const source = "class C {\n  setLayout = (l: string) => l + '!';\n}";
    const namePos = source.indexOf("setLayout") + "setLayout".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", namePos, [["(l: unknown) => unknown"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source); // unchanged — outer skipped
  });
});

describe("applyTypesToFile — class field inference from constructor params", () => {
  // Class instance fields don't get type annotations even when
  // constructor params + assignments fully determine them. The
  // transformer only instruments PropertyDeclaration with an
  // initializer; fields like `count;` without an initializer get no
  // observation. Constructor params ARE observed.
  //
  // Apply-time fix: walk the AST, for each PropertyDeclaration without
  // a type, look for `this.<field> = <param>` patterns in the
  // constructor and propagate the param's observed type to the field.
  // Generates synthetic type-info entries that flow through the normal
  // pipeline.

  it("infers a single field type from a constructor param assignment", () => {
    // class Counter {
    //   count;
    //   constructor(initial) { this.count = initial; }
    // }
    //
    // Constructor param "initial" observed as number → field "count" gets number.
    const source = `class Counter {
  count;
  constructor(initial) {
    this.count = initial;
  }
}`;
    // pos 36 = right after "initial" (param name)
    const initialEnd = source.indexOf("initial)") + "initial".length;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", initialEnd, [["number"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    // Expect: param annotated AND field annotated
    expect(result).toContain("constructor(initial: number)");
    expect(result).toMatch(/^\s*count: number;/m);
  });

  it("infers multiple fields from multiple constructor param assignments", () => {
    const source = `class User {
  name;
  age;
  constructor(name, age) {
    this.name = name;
    this.age = age;
  }
}`;
    const nameEnd = source.indexOf("name, age") + "name".length;
    const ageEnd = source.indexOf(", age)") + ", age".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", nameEnd, [["string"]]),
      entry("test.ts", ageEnd, [["number"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toMatch(/^\s*name: string;/m);
    expect(result).toMatch(/^\s*age: number;/m);
  });

  it("does not type a field when no matching constructor param assignment exists", () => {
    // Field is assigned only inside a method (not the constructor), so
    // there's no direct param→field link to walk. Don't infer.
    const source = `class Foo {
  count;
  reset() {
    this.count = 0;
  }
}`;
    const typeInfo: CollectedTypeInfo = [];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source); // unchanged — no observation, no inference
  });

  it("does not override an explicit field type", () => {
    // Field is already declared with a type; the field-inference should
    // not touch it.
    const source = `class Foo {
  count: bigint;
  constructor(initial) {
    this.count = initial;
  }
}`;
    const initialEnd = source.indexOf("initial)") + "initial".length;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", initialEnd, [["number"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    // Param annotated; field's existing `: bigint` stays.
    expect(result).toContain("constructor(initial: number)");
    expect(result).toContain("count: bigint;");
    expect(result).not.toContain("count: number");
  });

  it("does not double-handle fields with an initializer (transformer already instruments those)", () => {
    // `count = 0;` has an initializer → transformer instruments it via
    // the property-declaration path → an observation at the field's
    // position would already exist. Apply-time field inference must not
    // ALSO add a synthetic entry, otherwise we'd get a duplicate type
    // annotation on the field.
    const source = `class Foo {
  count = 0;
  constructor(initial) {
    this.count = initial;
  }
}`;
    // The transformer-emitted observation lands at field-name-end (16)
    // with the runtime-observed type. Simulate that.
    const fieldNameEnd = source.indexOf("count = 0") + "count".length;
    const initialEnd = source.indexOf("initial)") + "initial".length;
    const typeInfo: CollectedTypeInfo = [
      // From the transformer's __tscptr__.ret around the initializer 0
      entry("test.ts", fieldNameEnd, [["number"]], { varDecl: true }),
      // From the constructor param
      entry("test.ts", initialEnd, [["number"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("count: number = 0;");
    // Make sure we didn't get `count: number: number = 0;`
    expect(result.match(/count: number/g)?.length).toBe(1);
  });

  it("unions field types across multiple constructor-param assignments", () => {
    // Edge case: a field assigned from different params with different types.
    const source = `class Mixed {
  value;
  constructor(a, b) {
    if (a) this.value = a;
    else this.value = b;
  }
}`;
    const aEnd = source.indexOf("a, b)") + 1;
    const bEnd = source.indexOf(", b)") + 3;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", aEnd, [["string"]]),
      entry("test.ts", bEnd, [["number"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    // Expect a union of the two assignment sources
    expect(result).toMatch(/^\s*value: number\|string;/m);
  });
});

describe("applyTypesToFile — idempotency (re-apply on already-applied source)", () => {
  // Running apply twice with the same typeInfo on the same source must
  // not produce wrong types or duplicate annotations even though
  // positions in typeInfo are pre-shift offsets. The "already applied"
  // detection at each insertion site looks at the source state — if
  // the annotation is already there, the insert is skipped. Result:
  // ts-capture apply types.json is safe to re-run (no-op when nothing
  // has changed).

  it("does not double-annotate a function param", () => {
    // function foo(a) — pos 14 (after "a")
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];

    const after1 = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(after1).toBe("function foo(a: string) {}");

    // Re-apply with the SAME typeInfo on the now-modified source.
    // Position 14 in the modified source is `:`, our idempotency
    // guard short-circuits, output equals the input.
    const after2 = applyTypesToFile(after1, typeInfo, {});
    expect(after2).toBe(after1);
  });

  it.todo(
    "(known limitation) full multi-entry idempotency on already-applied source. " +
      "Pos-based check works for entries whose position is unaffected by " +
      "other applied entries, but not for entries that shift after earlier " +
      "applies. Robust full-file idempotency needs a CLI-level sidecar " +
      "manifest keyed on source-file hash + typeInfo hash.",
  );

  it("handles optional params (annotation written as `?:`)", () => {
    // function foo(a?) — pos 15 (after `?`)
    const source = "function foo(a?) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 15, [["number"], ["undefined"]])];

    const after1 = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(after1).toBe("function foo(a?: number) {}");

    const after2 = applyTypesToFile(after1, typeInfo, {});
    expect(after2).toBe(after1);
  });

  it("handles thisType annotations", () => {
    const source = "function greet() { return this.text; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 15, [["Date"]], { thisType: true })];

    const after1 = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(after1).toBe("function greet(this: Date) { return this.text; }");

    const after2 = applyTypesToFile(after1, typeInfo, {});
    expect(after2).toBe(after1);
  });

  it("does not block applying NEW entries on a partially-applied file", () => {
    // First apply only annotates `a`. Second run also has an entry for
    // `b` (a NEW observation that wasn't in the first types.json).
    // Idempotency must skip `a` (already annotated) but apply `b`.
    const source = "function foo(a, b) {}";
    const firstTypeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["number"]])];
    const after1 = applyTypesToFile(source, firstTypeInfo, {});
    expect(after1).toBe("function foo(a: number, b) {}");

    // Pos for `b` in the MODIFIED source: original was pos 17, now
    // shifted to 25 due to ": number" insertion (8 chars).
    const secondTypeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["number"]]), // already applied — skipped
      entry("test.ts", 25, [["string"]]), // new — applied
    ];
    const after2 = applyTypesToFile(after1, secondTypeInfo, {});
    expect(after2).toBe("function foo(a: number, b: string) {}");
  });

  it.todo(
    "(known limitation) idempotency on Bug-C-synthesized class-field entries. " +
      "Same pos-shift root cause as the multi-entry case above: when " +
      "field-decl pos shifts due to other applies, our naive pos-based " +
      "check misses it. Needs the same sidecar-manifest fix.",
  );
});

describe("applyTypesToFile — infer.ignoreExistingTypes", () => {
  // Divergence-measurement mode (ignore existing annotations):
  // when on, the idempotency check is bypassed so apply emits annotations
  // even at already-typed positions. Output may be syntactically invalid TS
  // (existing `: T` stays alongside the new one) — that's intentional;
  // the use case is grepping/diffing what ts-capture WOULD have emitted,
  // not producing clean rewrites.

  it("default behaviour unchanged: existing annotations are preserved (offset path)", () => {
    const source = "function foo(a: number) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });

  it("flag on (offset path): apply emits annotation despite existing one", () => {
    const source = "function foo(a: number) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: {
        ...INFER_DEFAULTS,
        requireTypeRefInScope: false,
        ignoreExistingTypes: true,
      },
    });
    // The new annotation is emitted at the param position; the existing
    // `: number` stays in source. Output is intentionally broken TS but
    // the new annotation is grep-able for divergence measurement.
    expect(result).toContain(": string");
    expect(result).not.toBe(source);
  });
});

describe("applyTypesToFiles", () => {
  // Tested via integration test since it involves file I/O
  it.todo("groups entries by filename and processes each file");
});

describe("applyTypesToFile — RewriteMostSpecificCommonBase (applier wiring)", () => {
  // The @sa chain collapse (rewriteCommonBase) and marker stripping
  // (stripAllChainMarkers) are unit-tested at the boundary in class-chain.spec.ts.
  // These e2e samples prove the applier wiring: markers are always stripped
  // before emit, the collapse is gated by the flag, and it reaches class unions
  // nested inside an object value via the recursive merge.
  it("always strips the @sa marker before emit, even with the flag off", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["Cat /* @sa:Animal */"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: Cat) {}");
  });

  it("with the flag on — collapses a class union to its shared ancestor", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["Cat /* @sa:Mammal|Animal */"], ["Dog /* @sa:Mammal|Animal */"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, rewriteCommonBase: true, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: Mammal) {}");
  });

  it("with the flag off — multiple classes stay a flat union (markers stripped)", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["Cat /* @sa:Animal */"], ["Dog /* @sa:Animal */"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: Cat|Dog) {}");
  });

  it("collapses a class union nested inside an object value position", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["{ pet: Cat /* @sa:Animal */ }"], ["{ pet: Dog /* @sa:Animal */ }"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, rewriteCommonBase: true, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: { pet: Animal }) {}");
  });
});

describe("applyTypesToFile — skipInferableVarDecls (applier wiring)", () => {
  // The syntactic inference (inferTypeFromInitializer) and the const/let/
  // readonly narrowing flag (buildInferableInfoMap) are unit-tested at the
  // boundary in initializer-inference.spec.ts. These e2e samples prove the
  // applier wiring: the suppression is gated on the flag, fires only on a
  // varDecl whose inferred type equals the emitted one, keeps the annotation
  // when the observation is wider, and never touches params / return types.
  it("OFF by default — `let x = 5` still gets `: number`", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("let x: number = 5;");
  });

  it("ON — `let x = 5` skips the redundant `: number`", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
    });
    expect(result).toBe(source);
  });

  it("ON — keeps the annotation when the observed type is WIDER than the inferred one", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 5, [["number"], ["string"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
    });
    expect(result).toBe("let x: number|string = 5;");
  });

  it("ON — class field `x = 5` skips the redundant `: number`", () => {
    const source = "class C { x = 5; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 11, [["number"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
    });
    expect(result).toBe(source);
  });

  it("ON — a function param is NEVER suppressed (TS does not infer params)", () => {
    const source = "function foo(a) { return a; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["number"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
    });
    expect(result).toBe("function foo(a: number) { return a; }");
  });
});

describe("applyTypesToFile — preferNamedInScope same-file matching (applier wiring)", () => {
  // The same-file index build and the exact / subset rewrite are unit-tested at
  // the boundary in named-type-index.spec.ts. These e2e samples prove the
  // applier wiring: the substitution is gated by preferNamedInScope, and both
  // the offset and CST paths emit the named form identically.
  it("explicit OFF — the structural type stays structural", () => {
    const source = "interface Foo { a: number }\nfunction f(x) { return x; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 40, [["{ a: number }"]], {})];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, preferNamedInScope: false },
    });
    expect(result).toContain("function f(x: { a: number })");
  });

  it("ON — an exact same-file match substitutes the name (offset path)", () => {
    const source = "interface Foo { a: number }\nfunction f(x) { return x; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 40, [["{ a: number }"]], {})];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, preferNamedInScope: true, cstAware: false },
    });
    expect(result).toContain("function f(x: Foo)");
  });

  it("ON — the CST applier substitutes identically (parity)", () => {
    const source = "interface Foo { a: number }\nfunction f(x) { return x; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 40, [["{ a: number }"]], {})];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, preferNamedInScope: true },
    });
    expect(result).toContain("function f(x: Foo)");
  });
});

describe("applyTypesToFile — requireTypeRefInScope (applier wiring)", () => {
  // The scope set (buildScopedTypeNames: imports, type-only imports, same-file
  // decls, ECMA-core allowlist) and the all-refs-in-scope check
  // (allTypeRefsInScope, incl. generic / union members) are unit-tested at the
  // boundary in scope-reachability.spec.ts. These e2e samples prove the applier
  // wiring: an out-of-scope ctor name is skipped (unless the flag is off), an
  // imported name lands, and the CST path enforces the same check.
  it("ON by default — skips an annotation referencing an unimported type", () => {
    const source = "function f(x) { return x; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 12, [["AppLogger"]], {})];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    expect(result).toBe(source);
  });

  it("OFF — emits the name even when unreachable (back-compat opt-out)", () => {
    const source = "function f(x) { return x; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 12, [["AppLogger"]], {})];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false, requireTypeRefInScope: false },
    });
    expect(result).toContain("function f(x: AppLogger)");
  });

  it("ON — keeps the annotation when the name is imported", () => {
    const source = "import { AppLogger } from './AppLogger';\nfunction f(x) { return x; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 53, [["AppLogger"]], {})];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    expect(result).toContain("function f(x: AppLogger)");
  });

  it("ON — the CST applier enforces the same scope check (parity)", () => {
    const source = "function f(x) { return x; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 12, [["AppLogger"]], {})];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toBe(source);
  });
});

describe("applyTypesToFile — TypeChecker-aware scope (applier wiring)", () => {
  // buildScopedTypeNamesViaTypeChecker (DOM ambients, file-not-in-program →
  // undefined, ctor arity) is unit-tested at the boundary in
  // scope-reachability.spec.ts. These e2e samples prove the applier wiring: with
  // a Program it uses the TypeChecker scope (lighting up DOM + cross-file
  // imports), and without one it falls back to the text-level scan.
  function makeProgram(files: Record<string, string>): {
    program: ts.Program;
    filename: string;
  } {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
    };
    const host = ts.createCompilerHost(compilerOptions);
    const realReadFile = host.readFile.bind(host);
    const realFileExists = host.fileExists.bind(host);
    const realGetSourceFile = host.getSourceFile.bind(host);
    host.readFile = (f: string) => files[f] ?? realReadFile(f);
    host.fileExists = (f: string) => f in files || realFileExists(f);
    host.getSourceFile = (f: string, target: ts.ScriptTarget) =>
      files[f] !== undefined
        ? ts.createSourceFile(f, files[f], target, true)
        : realGetSourceFile(f, target);
    const rootNames = Object.keys(files);
    const program = ts.createProgram(rootNames, compilerOptions, host);
    return { program, filename: rootNames[0] };
  }

  it("ON — a DOM type (HTMLElement) is in scope via the TypeChecker", () => {
    const { program, filename } = makeProgram({ "/test.ts": "function f(x) { return x; }" });
    const typeInfo: CollectedTypeInfo = [entry(filename, 12, [["HTMLElement"]], {})];
    const result = applyTypesToFile(
      "function f(x) { return x; }",
      typeInfo,
      { infer: { ...INFER_DEFAULTS, cstAware: false }, filename },
      program,
    );
    expect(result).toContain("function f(x: HTMLElement)");
  });

  it("ON — a direct cross-file import resolves to in-scope", () => {
    const source = "import { InnerType } from './inner.js';\nfunction f(x) { return x; }";
    const { program } = makeProgram({
      "/inner.ts": "export interface InnerType { a: number; }",
      "/test.ts": source,
    });
    const typeInfo: CollectedTypeInfo = [entry("/test.ts", 52, [["InnerType"]], {})];
    const result = applyTypesToFile(
      source,
      typeInfo,
      { infer: { ...INFER_DEFAULTS, cstAware: false }, filename: "/test.ts" },
      program,
    );
    expect(result).toContain("function f(x: InnerType)");
  });

  it("ON — without a Program, falls back to the text-level scan (DOM skipped)", () => {
    const source = "function f(x) { return x; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 12, [["HTMLElement"]], {})];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    expect(result).toBe(source);
  });
});

describe("applyTypesToFile — preferNamedInScope cross-file (applier wiring)", () => {
  // The cross-file index build (buildNamedTypeIndex with a Program — imports,
  // re-export barrels, generic-skip, same-file-collision precedence) is
  // unit-tested at the boundary in named-type-index.spec.ts. These e2e samples
  // prove the applier wiring: with a Program an imported interface name is
  // substituted; without one it falls back to same-file-only (no match).
  function makeProgram(files: Record<string, string>): {
    program: ts.Program;
    filename: string;
  } {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
    };
    const host = ts.createCompilerHost(compilerOptions);
    const realReadFile = host.readFile.bind(host);
    const realFileExists = host.fileExists.bind(host);
    const realGetSourceFile = host.getSourceFile.bind(host);
    host.readFile = (f: string) => files[f] ?? realReadFile(f);
    host.fileExists = (f: string) => f in files || realFileExists(f);
    host.getSourceFile = (f: string, target: ts.ScriptTarget) =>
      files[f] !== undefined
        ? ts.createSourceFile(f, files[f], target, true)
        : realGetSourceFile(f, target);
    const rootNames = Object.keys(files);
    const program = ts.createProgram(rootNames, compilerOptions, host);
    return { program, filename: rootNames[0] };
  }

  it("ON + Program — an imported interface name substitutes the structural type", () => {
    const source =
      "import { BookingState } from './state.js';\nfunction subscribe(s) { return s; }";
    const { program } = makeProgram({
      "/state.ts": "export interface BookingState { activeCustomer: string; uniqueId: string; }",
      "/test.ts": source,
    });
    const typeInfo: CollectedTypeInfo = [
      entry("/test.ts", 63, [["{ activeCustomer: string, uniqueId: string }"]], {}),
    ];
    const result = applyTypesToFile(
      source,
      typeInfo,
      {
        infer: { ...INFER_DEFAULTS, preferNamedInScope: true, cstAware: false },
        filename: "/test.ts",
      },
      program,
    );
    expect(result).toContain("function subscribe(s: BookingState)");
  });

  it("ON without a Program — falls back to same-file only (no cross-file match)", () => {
    const source =
      "import { BookingState } from './state.js';\nfunction subscribe(s) { return s; }";
    const typeInfo: CollectedTypeInfo = [
      entry("/test.ts", 63, [["{ activeCustomer: string, uniqueId: string }"]], {}),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, preferNamedInScope: true, cstAware: false },
    });
    expect(result).toContain("function subscribe(s: { activeCustomer: string, uniqueId: string })");
  });
});

describe("applyTypesToFile — paren-less arrow wrap is per-position", () => {
  // Sibling-entry coordination: the offset path derives `parens` from
  // source when `opts.arrow && !opts.parens`. But when the arrow-entry
  // itself is SKIPPED (requireTypeRefInScope, preferNamedInScope
  // substitution to unreachable name) and a sibling returnType-entry
  // lands at the same pos without `opts.arrow`, the wrap would be
  // missed → `state: T => body` (TS1005). detectParenLessArrowParam
  // is hoisted out of the per-entry gate and computed once per pos;
  // any landing entry triggers wrap. Dedup via Set<number> of
  // paramStarts.

  it("returnType-entry alone at paren-less arrow pos: wrap still happens", () => {
    // After preferNamedInScope rejects the arrow-entry, only the
    // returnType lands. Post-undefined-→-void widening, the lone
    // `undefined` return-observation is emitted as `: void`
    // (idiomatic for callbacks that don't intentionally return).
    const source = "store.subscribe(state => handle(state));";
    // pos 21 = right after `state`
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 21, [["undefined"]], { returnType: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    // Wrap MUST happen even though no arrow-entry is present.
    expect(result).toBe("store.subscribe((state): void => handle(state));");
  });

  it("arrow + returnType both land at paren-less pos: wrap once, both annotations land", () => {
    const source = "arr.map(x => x * 2);";
    // pos 9 = right after `x`
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 9, [["number"]], { arrow: true, parens: [8, 9] }),
      entry("test.ts", 9, [["number"]], { returnType: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    // `)` between param annotation and return annotation; no double `(`.
    expect(result).toBe("arr.map((x: number): number => x * 2);");
  });

  it("arrow-entry alone at paren-less pos: regression guard", () => {
    const source = "arr.map(x => x * 2);";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 9, [["number"]], { arrow: true, parens: [8, 9] }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    expect(result).toBe("arr.map((x: number) => x * 2);");
  });
});

describe("applyTypesToFile — paren-less arrow param wrapping", () => {
  // Without proper handling, the offset applier inserts `: T` after a
  // paren-less arrow param's name without restoring the wrapping
  // parens, producing `state: undefined => body` — TS1005. The
  // transformer normally sets `opts.parens` for these cases, but if
  // `parens` is missing (stale types.json, hand-synthesized entry),
  // the offset applier derives paren-less detection from source when
  // `opts.arrow` is set without `parens`.

  it("offset path — entry with arrow:true but no parens still wraps with parens", () => {
    const source = "arr.map(x => x * 2)";
    // pos 9 = right after `x` in `arr.map(x => ...)`
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 9, [["number"]], { arrow: true, requireTypeRefInScope: false } as never),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    expect(result).toBe("arr.map((x: number) => x * 2)");
  });

  it("offset path — paren-less arrow in callback context", () => {
    const source = "store.subscribe(state => handle(state));";
    // pos 21 = right after `state`
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 21, [["number"]], { arrow: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    expect(result).toBe("store.subscribe((state: number) => handle(state));");
  });

  it("offset path — arrow already wrapped in parens still works (no double-wrap)", () => {
    const source = "arr.map((x) => x * 2)";
    // pos 10 = right after `x` in `(x)`
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 10, [["number"]], { arrow: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    expect(result).toBe("arr.map((x: number) => x * 2)");
  });

  it("offset path — `const f = x => body` (assigned paren-less)", () => {
    const source = "const f = x => x * 2;";
    // pos 11 = right after `x`
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 11, [["number"]], { arrow: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, cstAware: false },
    });
    expect(result).toBe("const f = (x: number) => x * 2;");
  });
});

describe("applyTypesToFile — honorAsCasts", () => {
  // When the user writes `const w = window as MyWindow`, ts-capture
  // walking the runtime value and emitting a 6KB structural type
  // fights the user's intent. The transformer marks such entries
  // `hasAsCast: true`; apply consults `infer.honorAsCasts` (default
  // ON) and skips the annotation.

  it("ON by default — entry with hasAsCast is skipped", () => {
    const source = "const w = window as MyWindow;";
    // pos 7 = right after `w`
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 7, [["{ a: number }"]], { varDecl: true, hasAsCast: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source); // unchanged — cast wins
  });

  it("OFF — entry with hasAsCast still gets annotated (back-compat opt-out)", () => {
    const source = "const w = window as MyWindow;";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 7, [["{ a: number }"]], { varDecl: true, hasAsCast: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, honorAsCasts: false },
    });
    expect(result).toBe("const w: { a: number } = window as MyWindow;");
  });

  it("ON — varDecl WITHOUT hasAsCast still gets annotated normally", () => {
    const source = "const x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 7, [["number"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("const x: number = 5;");
  });
});

// Return types with sole-observation `undefined` widen to `void`. Bodies
// without an explicit return (event handlers, side-effect callbacks) are
// typed `void` by TS at the callsite; emitting `: undefined` would make
// the callsite reject under strict mode when the body is
// `console.log(...)` or another expression-statement.
describe("applyTypesToFile — returnType undefined widens to void (applier wiring)", () => {
  // The union-keeps-undefined / async-Promise<void> / non-returnType variants
  // are unit-tested at the boundary in compute-annotation.spec.ts. This e2e
  // sample proves the applier inserts `: void` for a sole-undefined return.
  it("single undefined observation on returnType emits `void`", () => {
    const source = "store.subscribe(state => handle(state));";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 21, [["undefined"]], { returnType: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("store.subscribe((state): void => handle(state));");
  });
});

// Opt-in diagnostic markers for approximation fallbacks
describe("applyTypesToFile — emitDiagnosticComments", () => {
  it("OFF by default — useless arrows are suppressed", () => {
    // With diagnostic comments OFF, a sole (x: unknown) => unknown
    // observation is treated as noise and produces no annotation. The
    // diagnostic-marker behavior moves to emitDiagnosticComments: true,
    // tested below.
    const source = "function foo(cb) {}";
    const typeInfo: CollectedTypeInfo = [
      ["test.ts", 15, [["(x: unknown) => unknown", undefined, "generic-fn"]], {}],
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source); // unchanged
  });

  it("ON — generic-fn reason produces `/* @ts-capture:generic-fn */` marker", () => {
    const source = "function foo(cb) {}";
    // pos 15 = right after `cb`
    const typeInfo: CollectedTypeInfo = [
      ["test.ts", 15, [["(x: unknown) => unknown", undefined, "generic-fn"]], {}],
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, emitDiagnosticComments: true },
    });
    expect(result).toBe(
      "function foo(cb: (x: unknown) => unknown /* @ts-capture:generic-fn */) {}",
    );
  });

  it("ON — shape-capped reason produces `/* @ts-capture:shape-capped */` marker", () => {
    const source = "let store = makeStore();";
    // pos 9 = right after `store`
    const typeInfo: CollectedTypeInfo = [
      ["test.ts", 9, [["Record<string, unknown>", undefined, "shape-capped"]], { varDecl: true }],
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, emitDiagnosticComments: true },
    });
    expect(result).toContain(": Record<string, unknown> /* @ts-capture:shape-capped */");
  });

  it("ON — entry with no reason produces no marker", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, emitDiagnosticComments: true },
    });
    expect(result).toBe("function foo(a: string) {}");
  });

  it("first-wins on multi-observation entries", () => {
    // Union of two observations — only one has a reason. The reason
    // wins (we report any approximation in the entry, even if some
    // observations were precise).
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      [
        "test.ts",
        14,
        [
          ["string", undefined],
          ["(x: unknown) => unknown", undefined, "generic-fn"],
        ],
        {},
      ],
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, emitDiagnosticComments: true },
    });
    expect(result).toContain("/* @ts-capture:generic-fn */");
  });
});

describe("applyTypesToFile — generic ctor arity expansion (applier wiring)", () => {
  // expandCtorArity and buildCtorArityMap are unit-tested at the boundary in
  // scope-reachability.spec.ts. These e2e samples prove the applier wires the
  // Program-derived arity map through expandCtorArity to fill a bare generic
  // class name (and does not double-expand an already-parameterized one).
  function makeProgram(files: Record<string, string>): {
    program: ts.Program;
    filename: string;
  } {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
    };
    const host = ts.createCompilerHost(compilerOptions);
    const realReadFile = host.readFile.bind(host);
    const realFileExists = host.fileExists.bind(host);
    const realGetSourceFile = host.getSourceFile.bind(host);
    host.readFile = (f: string) => files[f] ?? realReadFile(f);
    host.fileExists = (f: string) => f in files || realFileExists(f);
    host.getSourceFile = (f: string, target: ts.ScriptTarget) =>
      files[f] !== undefined
        ? ts.createSourceFile(f, files[f], target, true)
        : realGetSourceFile(f, target);
    const rootNames = Object.keys(files);
    const program = ts.createProgram(rootNames, compilerOptions, host);
    return { program, filename: rootNames[0] };
  }

  it("expands a bare generic class name to Name<unknown>", () => {
    const source =
      "class Container<T> { constructor(public value: T) {} }\nfunction f(x) { return x; }";
    const { program, filename } = makeProgram({ "/test.ts": source });
    const typeInfo: CollectedTypeInfo = [entry(filename, 67, [["Container"]], {})];
    const result = applyTypesToFile(
      source,
      typeInfo,
      { infer: { ...INFER_DEFAULTS, cstAware: false }, filename },
      program,
    );
    expect(result).toContain("function f(x: Container<unknown>)");
  });

  it("does not double-expand an already-parameterized generic", () => {
    const source = "class Container<T> {}\nfunction f(x) { return x; }";
    const { program, filename } = makeProgram({ "/test.ts": source });
    const typeInfo: CollectedTypeInfo = [entry(filename, 34, [["Container<unknown>"]], {})];
    const result = applyTypesToFile(
      source,
      typeInfo,
      { infer: { ...INFER_DEFAULTS, cstAware: false }, filename },
      program,
    );
    expect(result).toContain("function f(x: Container<unknown>)");
    expect(result).not.toContain("Container<unknown><unknown>");
  });
});

// --- Per-file ignore via ignoreFiles config ----------------------------
// Some files are predictably noisy targets — loggers that observe the
// whole app state, generated code, third-party adapters with their own
// type contracts. Let users exclude them from apply via a regex list
// instead of sprinkling `// @ts-capture-ignore` throughout.
describe("ignoreFiles config skips whole files", () => {
  it("returns source unchanged when filename matches any ignore pattern", () => {
    const source = "const v = make();";
    const pos = source.indexOf("const v ") + "const v".length;
    const typeInfo: CollectedTypeInfo = [
      entry("/src/utils/logger.ts", pos, [["string"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
      filename: "/src/utils/logger.ts",
      ignoreFiles: [/logger\.ts$/],
    });
    expect(result).toBe(source);
  });

  it("annotates files that do not match any ignore pattern", () => {
    const source = "const v = make();";
    const pos = source.indexOf("const v ") + "const v".length;
    const typeInfo: CollectedTypeInfo = [
      entry("/src/utils/helper.ts", pos, [["string"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
      filename: "/src/utils/helper.ts",
      ignoreFiles: [/logger\.ts$/],
    });
    expect(result).toContain(": string");
  });

  it("skips when ANY of multiple patterns matches", () => {
    const source = "const v = make();";
    const pos = source.indexOf("const v ") + "const v".length;
    const typeInfo: CollectedTypeInfo = [
      entry("/generated/Schema.ts", pos, [["string"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
      filename: "/generated/Schema.ts",
      ignoreFiles: [/logger\.ts$/, /^\/generated\//],
    });
    expect(result).toBe(source);
  });

  it("no-op when ignoreFiles is omitted", () => {
    const source = "const v = make();";
    const pos = source.indexOf("const v ") + "const v".length;
    const typeInfo: CollectedTypeInfo = [
      entry("/src/utils/logger.ts", pos, [["string"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
      filename: "/src/utils/logger.ts",
    });
    expect(result).toContain(": string");
  });
});

// --- @ts-capture-ignore comment opts out of annotation -----------------
// Users sometimes know better than the apply heuristic. `// @ts-capture-ignore`
// on the line preceding a declaration tells apply to leave that position
// alone. Matches the prior-art conventions of `// eslint-disable-next-line`
// and `// @ts-ignore` so the marker is immediately recognisable.
describe("@ts-capture-ignore comment skip", () => {
  it("skips varDecl annotation when @ts-capture-ignore comment is on prior line", () => {
    const source = "// @ts-capture-ignore\nconst v = make();";
    // pos = end of `v` in the source
    const pos = source.indexOf("const v ") + "const v".length;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["string"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source); // unchanged
  });

  it("still annotates when no ignore comment is present", () => {
    const source = "const v = make();";
    const pos = source.indexOf("const v ") + "const v".length;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["string"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": string");
  });

  it("recognises the marker via leading-comment attachment (not just text scan)", () => {
    // Multi-line comment form on the immediately-preceding line.
    const source = "/* @ts-capture-ignore */\nconst v = make();";
    const pos = source.indexOf("const v ") + "const v".length;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["string"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });

  it("ignore comment further up the file does not affect distant positions", () => {
    const source = "// @ts-capture-ignore\nconst skipped = a();\n\nconst kept = b();";
    const posKept = source.indexOf("const kept ") + "const kept".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", posKept, [["number"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("const kept: number");
  });

  it("skips function param annotation when ignore comment is on prior line", () => {
    const source = "// @ts-capture-ignore\nfunction foo(a) {}";
    // pos after `a`
    const pos = source.indexOf("(a") + 2;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["string"]])];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });
});

// --- union-producing initializer skip (applier wiring) -----------------
// The AST-shape detection (??, ||, &&, ternary, ?., Array#find/#findLast) is
// unit-tested at the boundary in skip-sets.spec.ts (unionProducingInitializer);
// the single-observation drop in annotation-eligibility.spec.ts. These e2e
// samples prove the applier wiring: a sole observation on a union-producing
// site is skipped, a genuine multi-type union is still annotated, and a
// non-union initializer (.map) is annotated from its single observation.
describe("skip undefined-narrowing on union-producing initializer (applier wiring)", () => {
  it("skips a `?? undefined` site when the sole observation is undefined", () => {
    const source = "const v = maybe() ?? undefined;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 7, [["undefined"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });

  it("skips a union-producing site on a single non-undefined observation (one branch seen)", () => {
    const source = "let mainId = flag ? compute() : undefined;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 10, [["number"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });

  it("STILL annotates a genuine multi-type union", () => {
    const source = "const v = maybe() ?? undefined;";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 7, [["undefined"], ["string"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("string");
    expect(result).toContain("undefined");
  });

  it("STILL annotates a non-union initializer like `arr.map(...)`", () => {
    const source = "let v = arr.map(x => x.id);";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number[]"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": number[]");
  });
});

// --- sole-undefined skip on opaque initializers (applier wiring) --------
// The opaque-initializer detection (await / call / method / new) is unit-tested
// at the boundary in skip-sets.spec.ts (opaqueInitializerVarDecls); the
// sole-undefined drop in annotation-eligibility.spec.ts. These e2e samples
// prove the applier wiring: a sole-undefined observation on an opaque call is
// skipped, while the literal `undefined` keyword form and a non-undefined
// observation are still annotated.
describe("skip sole-undefined on opaque initializers (applier wiring)", () => {
  it("skips `const v = call()` when the sole observation is undefined", () => {
    const source = "const v = getString(key);";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 7, [["undefined"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });

  it("STILL annotates a literal `= undefined` initializer", () => {
    const source = "let v = undefined;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["undefined"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": undefined");
  });

  it("STILL annotates an opaque call when the observation is NOT undefined", () => {
    const source = "const v = getString(key);";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 7, [["string"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": string");
  });
});

// --- subset-match for named-type rewrite (applier wiring) ---------------
// The subset-match algebra (optional-absent, recursive, array, extra-field /
// missing-required non-matches) is unit-tested at the boundary in
// named-type-index.spec.ts. This e2e sample proves the applier substitutes the
// named form when an observation omits a named type's optional field.
describe("subset-match for named-type rewrite (applier wiring)", () => {
  it("rewrites an observation to a named interface when an optional field is absent", () => {
    const source = [
      "interface Foo {",
      "  readonly a: number",
      "  readonly b: string",
      "  readonly c?: boolean",
      "}",
      "let v = getFoo();",
    ].join("\n");
    const pos = source.indexOf("let v") + "let v".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["{ a: number, b: string }"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": Foo");
    expect(result).not.toContain("{ a:");
  });
});

// --- subset rewrite descends into generic wrappers (applier wiring) -----
// The generic-wrapper descent (Promise / Array / Map / nested / union) is
// unit-tested at the boundary in named-type-index.spec.ts. This e2e sample
// proves the applier rewrites an inner shape inside a generic wrapper.
describe("subset rewrite descends into generic wrappers (applier wiring)", () => {
  it("rewrites the inner shape of `Promise<{ ... }>`", () => {
    const source = [
      "interface Resp {",
      "  readonly id: number",
      "  readonly name: string",
      "}",
      "let v = fetchResp();",
    ].join("\n");
    const pos = source.indexOf("let v") + "let v".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["Promise<{ id: number, name: string }>"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": Promise<Resp>");
  });
});

// --- Async function returning a Promise gets Promise<Promise<T>> --
// Async functions implicitly wrap their return in `Promise<>`. When the body
// returns an existing Promise (e.g. `return fetch().then(...)`), ts-capture
// observes the inner Promise as the runtime return value. Apply then wraps
// it again in `Promise<>` via opts.async, producing `Promise<Promise<T>>` —
// TS would unwrap the inner Promise instead.
//
// Fix: when emitting an async return type, unwrap any observed `Promise<X>`
// before applying the outer `Promise<>` wrap.
describe("async function returning Promise doesn't double-wrap (applier wiring)", () => {
  // The unwrap / still-wrap / union / mixed variants are unit-tested at the
  // boundary in compute-annotation.spec.ts. This e2e sample proves the applier
  // emits a single Promise<...> with no double-wrap.
  it("unwraps single `Promise<X>` observation under async", () => {
    const source = "async function f() { return fetch(''); }";
    const pos = source.indexOf(")") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["Promise<number>"]], { returnType: true, async: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": Promise<number>");
    expect(result).not.toContain(": Promise<Promise<");
  });
});

// --- Array.prototype-callback structural suppression (applier wiring) ---
// The set of contextually-typed Array.prototype methods (filter/map/some/find/
// forEach/reduce) and the param/returnType positions they flag are unit-tested
// at the boundary in skip-sets.spec.ts (arrayCallbackArrowParams); the
// structural-vs-primitive suppression decision in annotation-eligibility.spec.ts
// (suppressArrayCallbackStructural). These e2e samples prove the applier wiring.
describe("skip arrow-param annotation in Array.prototype callbacks (applier wiring)", () => {
  it("skips a structural param annotation inside `.filter(...)`", () => {
    const source = "const r = arr.filter(product => product.active);";
    const pos = source.indexOf("product") + "product".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["{ active: boolean, id: number }"]], {
        arrow: true,
        parens: [pos - "product".length, pos],
      }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).not.toContain("active: boolean");
    expect(result).not.toContain(": {");
  });

  it("skips a structural returnType annotation inside an array callback", () => {
    const source = "const r = arr.map(p => p.price);";
    const pos = source.indexOf("p ") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["{ campaignId: number, vat: number }"]], { returnType: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).not.toContain(": {");
  });

  it("STILL annotates a primitive returnType inside an array callback", () => {
    const source = "const r = arr.map(p => p.id);";
    const pos = source.indexOf("p ") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { returnType: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": number");
  });

  it("STILL annotates a structural param on a free arrow (not an array callback)", () => {
    const source = "const fn = (x) => x.id;";
    const pos = source.indexOf("(x)") + 2;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["{ id: number }"]], { arrow: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("id: number");
  });
});

// --- outer-annotation skip: generic context & explicit type-args -------
// Both collapse into the offset path's `skip` set, unit-tested at the boundary
// in skip-sets.spec.ts (buildOuterAnnotationSkipSet). These e2e samples prove
// the applier drops the outer annotation inside a generic enclosing function
// (annotating would burn the type parameter to a concrete sample) and on a call
// initializer already typed via explicit type arguments.
describe("skip varDecl annotation in generic context / with explicit type-args (applier wiring)", () => {
  it("skips a var-decl annotation inside a generic enclosing function", () => {
    const source =
      "function pick<T extends object>(o: T, k: keyof T) {\n" +
      "  const v = o[k];\n" +
      "  return v;\n" +
      "}";
    const pos = source.indexOf("const v = ") + "const v".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["number[]|undefined"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });

  it("skips a var-decl annotation when the initializer call has explicit type arguments", () => {
    const source = "const data = parseModelResponse<MyType>(json);";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 10, [["{ a: string, b: number }"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });
});

// --- Cap final annotation length ---------------------------------------
// Even after the collapse passes, some inferred types stay huge — typically
// logger / serializer functions that get passed the entire app state. A
// 19K-character annotation locks the entire state shape into the source
// and is worse than `any` for readability. Cap the final union string;
// when exceeded, suppress the annotation entirely (TS inference and any
// existing typing take over).
describe("maxAnnotationChars cap on final type string (applier wiring)", () => {
  // The cap / under-cap / tighter-cap / common-base-fallback variants are
  // unit-tested at the boundary in compute-annotation.spec.ts. These two e2e
  // samples prove the applier wiring: an over-cap shape writes no annotation,
  // and an over-cap @sa class-union collapses to its common base in source.
  function makeLongShape(fields: number): string {
    const pairs = Array.from({ length: fields }, (_, i) => `k${i}: string`);
    return `{ ${pairs.join(", ")} }`;
  }

  it("suppresses annotation when final type exceeds maxAnnotationChars", () => {
    const source = "let s = giant();";
    const huge = makeLongShape(500);
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [[huge]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });

  it("falls back to common base when a class-union exceeds the cap", () => {
    const source = "let pet = wild();";
    const classes = Array.from(
      { length: 20 },
      (_, i) => `LongClassNameNumber${i} /* @sa:Mammal|Animal */`,
    );
    const typeInfo: CollectedTypeInfo = [
      entry(
        "test.ts",
        7,
        classes.map((c) => [c] as [string]),
        { varDecl: true },
      ),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, maxAnnotationChars: 100 },
    });
    expect(result).toBe("let pet: Mammal = wild();");
  });
});

// --- Collapse cartesian-product object unions inside Array<...> --------
// When an observation contains an array of objects with multiple nullable
// fields, runtime emission produces `Array<{a:null,b:null} | {a:null,b:n}
//   | {a:n,b:null} | {a:n,b:n}>` — one inline shape per observed combo of
// null/value across fields. The logical type is
// `Array<{a: n|null, b: n|null}>` (field-level union). Merge same-keyset
// object shapes inside an Array<...> at apply time.
describe("cartesian-product collapse inside Array<...> (applier wiring)", () => {
  // The cartesian / single-variant / shared-key variants are unit-tested at the
  // boundary in type-merge.spec.ts. This e2e sample proves the applier emits the
  // collapsed shape through a varDecl, accepting either `{...}[]` or `Array<{...}>`.
  it("merges same-keyset object union into field-level unions", () => {
    const source = "let xs = list();";
    const cartesian =
      "Array<{ a: null, b: null } | { a: null, b: number } | { a: number, b: null } | { a: number, b: number }>";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 6, [[cartesian]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    // a and b should both end up as null|number, not as 4-way object union.
    // Accept both `{...}[]` and `Array<{...}>` forms and `|` vs ` | ` spacing.
    expect(result).toMatch(
      /let xs: (?:\{ a: null ?\| ?number, b: null ?\| ?number \}\[\]|Array<\{ a: null ?\| ?number, b: null ?\| ?number \}>)/,
    );
  });
});

// --- unknown[] handling (applier wiring) --------------------------------
// The union-collapse and object-field-suppression variants are unit-tested at
// the boundary in compute-annotation.spec.ts. These two e2e samples prove the
// applier wires both through a varDecl: dropping `unknown[]` from a union when
// a concrete array is present, and writing no annotation at all when an object
// field's value is `unknown[]`.
describe("unknown[] handling (applier wiring)", () => {
  it("drops unknown[] from a union when a concrete T[] is present", () => {
    const source = "let xs = list();";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 6, [["unknown[]"], ["string[]"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("let xs: string[]");
    expect(result).not.toContain("unknown[]");
  });

  it("writes no annotation when an object field's value is unknown[]", () => {
    const source = "const colorMap = build();";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["{ outline: unknown[], primary: string[], white: string[] }"]], {
        varDecl: true,
      }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    // Original source unchanged — no annotation written.
    expect(result).toBe(source);
  });
});

// --- Suppress useless `(unknown) => unknown` arrows ---------------------
// When observation degenerates to a function whose params and return are all
// unknown, the annotation adds no information beyond `Function`-ish — and
// usually less, because it locks the parameter count. Skip rather than emit.
describe("useless-arrow suppression on varDecl (applier wiring)", () => {
  // The all-unknown-suppression variants are unit-tested at the boundary in
  // compute-annotation.spec.ts. This e2e sample proves the applier writes no
  // annotation when the sole observation is a useless `(arg: unknown) => unknown`.
  it("does not annotate when sole observation is (arg: unknown) => unknown", () => {
    const source = "let cb = registerHandler();";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 6, [["(arg: unknown) => unknown"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source); // unchanged
  });
});

describe("skip annotation when offset falls inside an ImportDeclaration", () => {
  // Real-world report: react-admin/examples/crm eval surfaced a snapshot
  // entry with `varDecl:true` at an offset inside a multi-line `import { ... }`
  // statement. Apply happily emitted `import: boolean { ... }` on that file —
  // not parseable TypeScript. Regardless of how the bad observation arose
  // (instrumenter quirk, position shift, etc.), apply must defensively
  // refuse to insert a type annotation at any offset whose enclosing AST
  // chain contains an ImportDeclaration. See REPORT.md §Bug 1.

  it("does not annotate position inside multi-line import-binding block", () => {
    const source = [
      "import { createContext, ReactNode, useContext } from 'react';",
      "import {",
      "    defaultCompanySectors,",
      "} from './defaultConfiguration';",
      "",
      "const x = true;",
    ].join("\n");
    // Offset 68 lands between "import" and "{" in the second import.
    const typeInfo: CollectedTypeInfo = [entry("test.tsx", 68, [["boolean"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {});
    // The import block must be left intact.
    expect(result).toContain("import {\n    defaultCompanySectors,\n} from");
    expect(result).not.toContain("import:");
  });

  it("does not annotate position inside single-line import", () => {
    const source = "import { foo } from './bar';\nconst x = true;";
    // Offset 7 is inside `import { foo }`.
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 7, [["string"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toContain("import { foo } from './bar';");
    expect(result).not.toMatch(/import.*:/);
  });

  it("still annotates legitimate varDecl elsewhere in same file", () => {
    // Defensive: the new guard must be narrow — varDecls outside imports
    // are still annotated as before.
    const source = "import { foo } from './bar';\nconst x = true;";
    const declStart = source.indexOf("const x") + "const x".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", declStart, [["boolean"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toContain("const x: boolean = true;");
  });
});

describe("skip varDecl annotation when offset is not a valid name-end position", () => {
  // Real-world report: react-admin/examples/crm eval emitted
  // `export const: string TasksList = () => { ... }` — the annotation
  // landed between `const` and the identifier instead of after the
  // identifier. Likely cause: source-position drift between the
  // instrumenter's view (post-JSX-transform code in the Vite plugin)
  // and apply's view (original TSX). Regardless of cause, apply must
  // refuse to emit a `varDecl` annotation at any offset that isn't the
  // exact `name.end` of an Identifier-named Variable/PropertyDeclaration
  // with an initializer. See REPORT.md §Bug 2.

  it("does not annotate offset between `const` keyword and identifier", () => {
    const source = "export const TasksList = () => null;\n";
    // Position 12 == end of "const" keyword, before the space + identifier.
    const typeInfo: CollectedTypeInfo = [entry("test.tsx", 12, [["string"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toBe(source);
  });

  it("does not annotate offset between `export` keyword and `const`", () => {
    const source = "export const x = 1;\n";
    // Position 6 == end of "export" keyword.
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 6, [["number"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toBe(source);
  });

  it("still annotates at the correct identifier-end position", () => {
    // Use a non-arrow RHS to avoid colliding with the existing
    // function-expression skip rule.
    const source = "export const taskCount = 5;\n";
    // Position == end of "taskCount" identifier.
    const declEnd = source.indexOf("taskCount") + "taskCount".length;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", declEnd, [["number"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toContain("const taskCount: number = ");
  });
});

describe("apply refuses to emit ungrammatical type strings", () => {
  // The runtime stringifier has been hardened in type-collector.ts to
  // produce parseable types for destructured / renamed fn params (see
  // type-collector.spec.ts). This guard is defense-in-depth:
  // if any code path — a future bug, a third-party stringifier — feeds
  // apply a non-parseable type string, apply must skip the site rather
  // than write unparseable TypeScript.

  it("skips when the emitted type does not parse as TypeScript", () => {
    const source = "const handler = makeHandler();\n";
    const declEnd = source.indexOf("handler") + "handler".length;
    // The exact garbage string the runtime produced in the react-admin
    // eval (Bug 4b). Even at a legitimate varDecl name-end, apply must
    // refuse to write this.
    const typeInfo: CollectedTypeInfo = [
      entry("t.ts", declEnd, [["(request: eObject: {request: e: unknown}) => unknown"]], {
        varDecl: true,
      }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe(source);
  });

  it("still emits when the type is parseable", () => {
    const source = "const count = compute();\n";
    const declEnd = source.indexOf("count") + "count".length;
    const typeInfo: CollectedTypeInfo = [entry("t.ts", declEnd, [["number"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("const count: number = ");
  });
});

describe("regression — JSX attribute / component name offsets are rejected", () => {
  // The eval against react-admin/examples/crm produced output like
  //   <Box display: { later: {...} }="flex" ...>
  //   <CardActions: () => unknown sx={{...}}>
  // — apply inserted at offsets that resolved to a JSX attribute name
  // and a JSX component name. These offsets are not legitimate
  // `name.end` positions for a VariableDeclaration in the same source,
  // so the `validVarDeclEnds` guard already filters them.
  // These tests pin that coverage explicitly so a future regression in
  // the guard would surface as a JSX-shaped test failure. See
  // REPORT.md §Bug 3.

  it("rejects offset that lands at a JSX attribute name end", () => {
    const source = `function C() { return <Box display="flex" />; }\n`;
    const attrEnd = source.indexOf("display") + "display".length;
    const typeInfo: CollectedTypeInfo = [entry("t.tsx", attrEnd, [["string"]], { varDecl: true })];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toBe(source);
  });

  it("rejects offset that lands at a JSX component name end", () => {
    const source = `function C() { return <CardActions sx={{}} />; }\n`;
    const compEnd = source.indexOf("CardActions") + "CardActions".length;
    const typeInfo: CollectedTypeInfo = [
      entry("t.tsx", compEnd, [["() => unknown"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toBe(source);
  });

  it("still annotates a real varDecl whose name happens to match a JSX attribute name", () => {
    // Defensive: if a `const display = ...` legitimately exists in the
    // file, its annotation must still land — even though `display` is
    // also used as a JSX attribute name later. The guard is
    // offset-based, not name-based.
    const source = `const display = { later: 1 };
function C() { return <Box display="flex" />; }
`;
    const declEnd = source.indexOf("display") + "display".length;
    const typeInfo: CollectedTypeInfo = [
      entry("t.tsx", declEnd, [["{ later: number }"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {});
    expect(result).toContain("const display: { later: number } = ");
    // The JSX attribute must not have been touched.
    expect(result).toContain(`<Box display="flex" />`);
  });
});

describe("extension: skip outer varDecl annotation when RHS is an object of methods", () => {
  // The `objectLiteralHasMethodProperty` heuristic for both
  // method-property detection and spread-assignment detection
  // was removed. Both cases produce consumer-side type
  // errors when the annotated narrow shape conflicts with the
  // expected interface — caught by the oracle directly (one surfaces via
  // same-file property-access TS2339; the other via the transitive scan
  // when a consumer typechecks against an interface). Oracle-based
  // regression tests live in apply-types-cst.spec.ts under
  // "TypeChecker verify integration".

  it("STILL annotates a plain-data object (no method properties)", () => {
    // Defensive: an object with only data values is fair game for
    // annotation — there's no contextual-typing tension because the
    // declared type wouldn't be a provider-style interface.
    const source = "const config = { url: '/api', timeout: 5000 };\n";
    const declEnd = source.indexOf("config") + "config".length;
    const typeInfo: CollectedTypeInfo = [
      entry("t.ts", declEnd, [["{ url: string, timeout: number }"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("const config: { url: string, timeout: number } = ");
  });

  // `emittedHasUselessArrowMethod` was removed — the real
  // regression (annotating a structural object of useless-arrow
  // methods burns away contextual typing against a consumer's
  // declared interface like `DataProvider`) is now caught by the
  // TypeChecker oracle via the transitive importer scan. The
  // oracle-based regression test lives in apply-types-cst.spec.ts
  // under "TypeChecker verify integration".

  it("STILL annotates plain object with no useless-arrow methods", () => {
    // Defensive: object types that are pure data, or that contain
    // arrow methods with REAL signatures, should still annotate.
    const source = "const result = compute();\n";
    const declEnd = source.indexOf("result") + "result".length;
    const typeInfo: CollectedTypeInfo = [
      entry(
        "t.ts",
        declEnd,
        [["{ score: number, label: string, format: (n: number) => string }"]],
        { varDecl: true },
      ),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(
      "const result: { score: number, label: string, format: (n: number) => string } = ",
    );
  });

  // The `narrowingReturnTypeFns` heuristic + supporting helpers
  // (`expressionCanBeUndefined`, `fnBodyReturnsUndefinedOrNull`) were
  // removed. The real regression — writing a narrow returnType
  // on a function whose body has `return undefined;` causes TS2322 at
  // the function's own `return undefined` line — fires AT the function
  // itself, so the oracle catches it directly (no transitive scan
  // needed). Oracle-based regression test lives in
  // apply-types-cst.spec.ts under "TypeChecker verify integration".

  it("STILL annotates returnType when all branches return the same shape", () => {
    // Defensive: function with exactly one return shape gets annotated.
    const source = `function compute(x: number) {
    return x * 2;
}
`;
    const paramsClose = source.indexOf(")") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("t.ts", paramsClose, [["number"]], { returnType: true }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("function compute(x: number): number {");
  });

  // The `satisfiesContextPositions` + `hasSatisfiesAncestor`
  // heuristic was removed. The real regression — annotating
  // an arrow's param with a structural shape that doesn't satisfy
  // the satisfies clause makes the `satisfies` expression itself
  // fail type-check — fires AT the satisfies expression (same file
  // as the annotation), so the oracle catches it directly. Oracle
  // regression test lives in apply-types-cst.spec.ts under
  // "TypeChecker verify integration".

  it("STILL annotates an arrow outside any satisfies / typed context", () => {
    // Defensive: arrows not inside a satisfies / typed context should
    // still get annotations.
    const source = "const compute = (x) => x * 2;\n";
    const paramEnd = source.indexOf("x)") + 1;
    const typeInfo: CollectedTypeInfo = [entry("t.ts", paramEnd, [["number"]], { arrow: true })];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain("(x: number)");
  });

  // The `isUselessPromise` heuristic was removed — the real
  // regression (annotating `: Promise<unknown>` on a slot typed
  // `() => Promise<void>` breaks contextual typing) is now caught
  // directly by the TypeChecker oracle through the transitive
  // importer scan. The oracle-based regression test lives in
  // apply-types-cst.spec.ts under "TypeChecker verify integration".

  it("STILL annotates returnType when emitted is a useful Promise<T>", () => {
    const source = `const fetchUser = () => fetchAPI();\n`;
    const paramsClose = source.indexOf("()") + 2;
    const typeInfo: CollectedTypeInfo = [
      entry("t.ts", paramsClose, [["Promise<{ id: number, name: string }>"]], {
        returnType: true,
        async: true,
        fnRetPos: paramsClose,
      }),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toContain(": Promise<{ id: number, name: string }>");
  });

  // The spread-RHS detection and the shorthand-method variant were removed
  // along with `objectLiteralHasMethodProperty`. See the
  // describe-block header above for where the oracle-based regression
  // tests live.
});

describe("irDedupUnion fn-paren at apply boundary", () => {
  // The `union-member` SerializeCtx wraps
  // fn types in parens when they appear as union members in IR. The
  // fix was complete inside type-ir.ts. But `irDedupUnion` calls
  // `serializeType` at the default `top` context and returns a
  // `string[]`; the outer caller in apply-types.ts then joins those
  // strings with `|`, reintroducing the precedence ambiguity that the
  // E fix was meant to prevent.
  it("wraps fn members in parens when joined with non-fn members at the apply boundary", () => {
    // Two fn observations where the wider-param fn is subsumed by the
    // narrower one (contravariant param: `string|number` ⊆ `string` in
    // fn-subtype terms — fewer-input fn is the subtype). A plain
    // `string` observation is also in the union. After irDedupUnion
    // drops the broader fn and re-serializes, the kept members are
    // [(a: string) => number, string]. Without per-member context
    // awareness at the join site, this comes out as
    // `(a: string) => number|string` which TS parses as
    // `(a: string) => (number | string)`.
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [
        ["(a: string | number) => number"],
        ["(a: string) => number"],
        ["string"],
      ]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    // Expected: fn wrapped in parens before the `|`.
    expect(result).toContain("((a: string) => number)");
    expect(result).not.toMatch(/=> number\|string/);
  });
});

describe("applyTypesToFile — lub fallback (applier wiring)", () => {
  // The bail / structural-recovery / disjoint→unknown / legacy-succeeds variants
  // are unit-tested at the boundary in type-merge.spec.ts. This e2e sample proves
  // the applier-level wiring: disjoint shapes that lub collapses to `unknown` get
  // the polymorphic-position diagnostic marker when diagnostics are enabled.
  it("(lubFallback on + diagnostic comments) disjoint shapes get polymorphic-position marker", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["{ a: number }"], ["{ b: string }"]]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: {
        ...INFER_DEFAULTS,
        requireTypeRefInScope: false,
        lubFallback: true,
        emitDiagnosticComments: true,
      },
    });
    expect(result).toContain("unknown /* @ts-capture:polymorphic-position */");
  });
});

describe("applyTypesToFile — built-in shape recognition (applier wiring)", () => {
  // The Promise / Map / disabled / missing-key variants are unit-tested at the
  // boundary in type-merge.spec.ts. This e2e sample proves the applier emits the
  // recognized named ref through a param annotation.
  it("rewrites Promise structural shape to Promise<unknown> (default-on)", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [
        ["{ then: (cb: unknown) => unknown, catch: (cb: unknown) => unknown }"],
      ]),
    ];
    const result = applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
    });
    expect(result).toBe("function foo(a: Promise<unknown>) {}");
  });
});

describe("ApplyTelemetry", () => {
  // Counters mutate in place; the caller (cmdApply or a test) allocates
  // one telemetry object and threads it through every apply call.

  it("counts emit + idempotent + total on a mixed run (offset path)", () => {
    // Three entries:
    //   - one fresh param annotation (emit)
    //   - one already-typed param at the same position re-applied (idempotent)
    //   - one position that would collapse to no annotation via existing
    //     heuristics → falls under 'other' / not emit / not idempotent
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];

    const t = newApplyTelemetry();
    applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
      telemetry: t,
    });
    expect(t.totalEntries).toBe(1);
    expect(t.emitted).toBe(1);
    expect(t.idempotent).toBe(0);

    // Re-apply on the now-typed source: the same entry hits the
    // idempotent skip.
    const sourceAfter = "function foo(a: string) {}";
    const t2 = newApplyTelemetry();
    applyTypesToFile(sourceAfter, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
      telemetry: t2,
    });
    expect(t2.totalEntries).toBe(1);
    expect(t2.idempotent).toBe(1);
    expect(t2.emitted).toBe(0);
  });

  it("counts positionMismatch when offset is stale", () => {
    // Source has `foo(a)` but our typeInfo points at pos 99 — past EOF.
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 99, [["string"]])];

    const t = newApplyTelemetry();
    applyTypesToFile(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
      telemetry: t,
    });
    expect(t.totalEntries).toBe(1);
    expect(t.emitted).toBe(0);
    expect(t.positionMismatch).toBe(1);
  });
});
