import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { CollectedTypeInfo } from "./type-collector.js";

import { INFER_DEFAULTS } from "./configuration.js";
import { newApplyTelemetry } from "./contract.js";
import {
  applied,
  type AppliedOptions,
  entry,
  nodesOf,
  parseErrors,
  reapplied,
} from "./test-utils/applied.js";

const ANY_NAME: AppliedOptions = {
  infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false },
};
const withInfer = (infer: Partial<typeof INFER_DEFAULTS>): AppliedOptions => ({
  infer: { ...INFER_DEFAULTS, ...infer },
});
const firstArrow = (out: ReturnType<typeof applied>): ts.ArrowFunction =>
  nodesOf(out, ts.isArrowFunction)[0];

describe("apply", () => {
  it("inserts a single type annotation", () => {
    // function foo(a) {}
    //               ^14
    const out = applied("function foo(a) {}", [entry("test.ts", 14, [["string"]])], ANY_NAME);
    expect(out).toAnnotate("a", "string");
  });

  // Regression: nestjs/nest, packages/core/router/router-response-controller.ts.
  // A promise executor parameter was observed twice at one offset — once as
  // the arrow parameter, once as the return of calling it (`paramReturn`).
  // Both were emitted, producing `(resolve: undefined: Function)`, which does
  // not parse and took 21 spec files down with it.
  it("emits one annotation when a position is observed as both a param and a paramReturn", () => {
    // const run = (resolve) => { resolve(); };
    //                     ^20
    const out = applied(
      "const run = (resolve) => { resolve(); };",
      [
        entry("test.ts", 20, [["Function"]], { arrow: true, fnRetPos: 21 }),
        entry("test.ts", 20, [["undefined"]], { paramReturn: true, paramReturnMember: "resolve" }),
      ],
      ANY_NAME,
    );
    expect(parseErrors(out)).toEqual([]);
    expect(out).toAnnotate("resolve", "Function");
  });

  it("writes nothing for an observation of a typed position, even with ignoreExistingTypes", () => {
    // function foo(a: string): string { return a; }
    //               ^14      ^23
    const source = "function foo(a: string): string { return a; }";
    const out = applied(
      source,
      [
        entry("test.ts", 14, [["number"]], { annotated: true }),
        entry("test.ts", 23, [["number"]], { returnType: true, annotated: true }),
      ],
      withInfer({ ignoreExistingTypes: true, requireTypeRefInScope: false }),
    );
    expect(out.text).toBe(source);
  });

  it("inserts annotations for multiple parameters", () => {
    // function foo(a, b) {}
    //               ^14  ^17
    const out = applied(
      "function foo(a, b) {}",
      [entry("test.ts", 14, [["number"]]), entry("test.ts", 17, [["string"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "number");
    expect(out).toAnnotate("b", "string");
  });

  it("creates union types from multiple observations", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [["string"], ["number"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "number | string");
  });

  it("deduplicates repeated type observations", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [["string"], ["string"], ["number"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "number | string");
  });

  it("removes 'undefined' from optional parameter types", () => {
    // function foo(a?) {}
    //               ^14, ? at 14, so pos is 15
    const out = applied(
      "function foo(a?) {}",
      [entry("test.ts", 15, [["number"], ["undefined"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "number");
    expect(nodesOf(out, ts.isParameter)[0].questionToken).toBeDefined();
  });

  it("skips entry when all types are undefined for optional param", () => {
    const out = applied("function foo(a?) {}", [entry("test.ts", 15, [["undefined"]])], ANY_NAME);
    expect(out).toLeaveUntyped("a");
  });

  it("skips entry when no types observed", () => {
    const out = applied("function foo(a) {}", [entry("test.ts", 14, [])], ANY_NAME);
    expect(out).toLeaveUntyped("a");
  });

  it("skips entry with only null/undefined type names", () => {
    const out = applied("function foo(a) {}", [entry("test.ts", 14, [[undefined]])], ANY_NAME);
    expect(out).toLeaveUntyped("a");
  });

  // The prefix is text put in front of the type, so the text is the claim.
  it("adds prefix before type when configured", () => {
    const out = applied("function foo(a) {}", [entry("test.ts", 14, [["string"]])], {
      prefix: "/*auto*/",
    });
    expect(out.text).toBe("function foo(a: /*auto*/string) {}");
  });

  it("handles arrow function parens option", () => {
    // x => x + 1  (no parens originally)
    // parens: [0, 1] means wrap param range with ()
    const out = applied(
      "x => x + 1",
      [entry("test.ts", 1, [["number"]], { arrow: true, parens: [0, 1] })],
      ANY_NAME,
    );
    expect(out).toAnnotate("x", "number");
    expect(out.text).toBe("(x: number) => x + 1");
  });

  it("handles thisType option", () => {
    // parameters.pos is right after '('  => offset 15
    const out = applied(
      "function greet() { return this.text; }",
      [entry("test.ts", 15, [["Date"]], { thisType: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("this", "Date");
  });

  it("handles thisNeedsComma with existing params", () => {
    const out = applied(
      "function greet(name) { return this.text + name; }",
      [
        entry("test.ts", 15, [["Date"]], { thisType: true, thisNeedsComma: true }),
        entry("test.ts", 19, [["string"]]),
      ],
      ANY_NAME,
    );
    expect(parseErrors(out)).toEqual([]);
    expect(out).toAnnotate("this", "Date");
    expect(out).toAnnotate("name", "string");
  });

  it("returns source unchanged for empty type info", () => {
    const source = "function foo(a) {}";
    expect(applied(source, []).text).toBe(source);
  });

  it("annotates the entries it is given", () => {
    // The applier processes every entry it gets; the caller groups by
    // file. Only this file's entry is passed here.
    const typeInfo: CollectedTypeInfo = [
      entry("other.ts", 14, [["number"]]),
      entry("test.ts", 14, [["string"]]),
    ];
    const out = applied(
      "function foo(a) {}",
      typeInfo.filter(([f]) => f === "test.ts"),
    );
    expect(out).toAnnotate("a", "string");
  });
});

describe("merging object types for optional properties", () => {
  // One end-to-end sample proving a merged object reaches the inserted
  // annotation. The merge-algebra variations live in `type-merge.spec.ts`
  // ("mergeTypes — object-merge variations"), tested against mergeTypes directly.
  it("merges two object types with overlapping keys into one with optional properties", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [["{ age: number, name: string }"], ["{ name: string }"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "{ age?: number; name: string }");
  });
});

describe("discriminated union detection (applier wiring)", () => {
  // The mergeTypes discriminator / recursive-merge / literal / cross-sample
  // array algebra is unit-tested at the boundary in type-merge.spec.ts. These
  // end-to-end samples prove the applier wires that algebra through the full
  // pipeline — collapseLiteral, scope / annotation emit, and the final sorted
  // union join.
  it("merges through when no shared-key value is a literal", () => {
    const out = applied(
      "function foo(a) {}",
      [
        entry("test.ts", 14, [
          ["{ kind: number, value: number }"],
          ["{ kind: string, items: string[] }"],
        ]),
      ],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "{ items?: string[]; kind: number | string; value?: number }");
  });

  it("bails to a flat union when a shared key has literal types", () => {
    const out = applied(
      "function foo(a) {}",
      [
        entry("test.ts", 14, [
          ['{ kind: "a", value: number }'],
          ['{ kind: "b", items: string[] }'],
        ]),
      ],
      withInfer({
        requireTypeRefInScope: false,
        literal: { ...INFER_DEFAULTS.literal, string: true },
      }),
    );
    expect(out).toAnnotate("a", '{ kind: "a"; value: number } | { kind: "b"; items: string[] }');
  });

  it("recursively merges nested object values end-to-end", () => {
    const out = applied(
      "function foo(a) {}",
      [
        entry("test.ts", 14, [
          ["{ config: { value: string } }"],
          ["{ config: { value: number } }"],
        ]),
      ],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "{ config: { value: number | string } }");
  });

  it("widens nested literals through the in-pipeline collapse", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [['{ a: "yes", b: 42, c: true }']])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "{ a: string; b: number; c: boolean }");
  });

  it("merges a cross-sample array beside a non-array", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [["number[]"], ["string[]"], ["boolean"]])],
      withInfer({ crossSampleArrayMerge: true }),
    );
    expect(out).toAnnotate("a", "(number | string)[] | boolean");
  });
});

describe("apply — outer-annotation skip on typed-RHS var declarations (applier wiring)", () => {
  // The function-expression-RHS detection (across const-arrow, function-expr,
  // and class-field PropertyDeclaration) is unit-tested at the boundary in
  // skip-sets.spec.ts (buildOuterAnnotationSkipSet); the drop decision in
  // annotation-eligibility.spec.ts (decideVarDeclSite). These e2e samples prove
  // the applier wiring: an outer annotation is skipped on a function RHS (it
  // would contravariantly conflict with the typed RHS / inner observations),
  // still emitted for a non-function RHS, and the skip does not block
  // inner-position observations.
  it("skips the outer annotation when the RHS is a function expression", () => {
    const out = applied(
      "const fullyTyped = (name: string): string => name;",
      [entry("test.ts", 16, [["(name: unknown) => unknown"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("fullyTyped");
  });

  it("STILL adds the outer annotation for a non-function RHS value", () => {
    const out = applied(
      "const count = 42;",
      [entry("test.ts", 11, [["number"]], { varDecl: true })],
      withInfer({ requireTypeRefInScope: false, skipRedundantAnnotations: false }),
    );
    expect(out).toAnnotate("count", "number");
  });

  it("skips the outer annotation but still applies an inner-position observation", () => {
    // pos 7 = right after "f"; pos 12 = right after "n"
    const out = applied(
      "const f = (n) => n + 1;",
      [
        entry("test.ts", 7, [["(n: unknown) => unknown"]], { varDecl: true }),
        entry("test.ts", 12, [["number"]]),
      ],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("f");
    expect(out).toAnnotate("n", "number");
  });

  it("skips the outer annotation for a class-field arrow (PropertyDeclaration)", () => {
    const source = "class C {\n  setLayout = (l: string) => l + '!';\n}";
    const namePos = source.indexOf("setLayout") + "setLayout".length;
    const out = applied(
      source,
      [entry("test.ts", namePos, [["(l: unknown) => unknown"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("setLayout");
  });
});

describe("apply — class field inference from constructor params", () => {
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
    const source = `class Counter {
  count;
  constructor(initial) {
    this.count = initial;
  }
}`;
    const initialEnd = source.indexOf("initial)") + "initial".length;
    const out = applied(source, [entry("test.ts", initialEnd, [["number"]])], ANY_NAME);
    expect(out).toAnnotate("initial", "number");
    expect(out).toAnnotate("count", "number");
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
    const out = applied(
      source,
      [entry("test.ts", nameEnd, [["string"]]), entry("test.ts", ageEnd, [["number"]])],
      ANY_NAME,
    );
    // The fields come first in the source, so the first `name` and `age`
    // found are the fields.
    expect(out).toAnnotate("name", "string");
    expect(out).toAnnotate("age", "number");
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
    const out = applied(source, [], ANY_NAME);
    expect(out.text).toBe(source);
  });

  it("does not override an explicit field type", () => {
    const source = `class Foo {
  count: bigint;
  constructor(initial) {
    this.count = initial;
  }
}`;
    const initialEnd = source.indexOf("initial)") + "initial".length;
    const out = applied(source, [entry("test.ts", initialEnd, [["number"]])], ANY_NAME);
    expect(out).toAnnotate("initial", "number");
    expect(out).toAnnotate("count", "bigint");
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
    const fieldNameEnd = source.indexOf("count = 0") + "count".length;
    const initialEnd = source.indexOf("initial)") + "initial".length;
    const out = applied(
      source,
      [
        // From the transformer's __tscptr__.ret around the initializer 0
        entry("test.ts", fieldNameEnd, [["number"]], { varDecl: true }),
        // From the constructor param
        entry("test.ts", initialEnd, [["number"]]),
      ],
      withInfer({ requireTypeRefInScope: false, skipRedundantAnnotations: false }),
    );
    expect(parseErrors(out)).toEqual([]);
    expect(out).toAnnotate("count", "number");
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
    const out = applied(
      source,
      [entry("test.ts", aEnd, [["string"]]), entry("test.ts", bEnd, [["number"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("value", "number | string");
  });
});

describe("apply — idempotency (re-apply on already-applied source)", () => {
  // Running apply twice with the same typeInfo on the same source must
  // not produce wrong types or duplicate annotations even though
  // positions in typeInfo are pre-shift offsets. The "already applied"
  // detection at each insertion site looks at the source state — if
  // the annotation is already there, the insert is skipped. Result:
  // ts-capture apply types.json is safe to re-run (no-op when nothing
  // has changed).

  it("does not double-annotate a function param", () => {
    const out = applied("function foo(a) {}", [entry("test.ts", 14, [["string"]])], ANY_NAME);
    expect(out).toAnnotate("a", "string");
    // Re-apply with the SAME typeInfo on the now-modified source.
    // Position 14 in the modified source is `:`, the idempotency guard
    // short-circuits, output equals the input.
    expect(reapplied(out)).toBe(out.text);
  });

  it.todo(
    "(known limitation) full multi-entry idempotency on already-applied source. " +
      "Pos-based check works for entries whose position is unaffected by " +
      "other applied entries, but not for entries that shift after earlier " +
      "applies. Robust full-file idempotency needs a CLI-level sidecar " +
      "manifest keyed on source-file hash + typeInfo hash.",
  );

  it("handles optional params (annotation written as `?:`)", () => {
    const out = applied(
      "function foo(a?) {}",
      [entry("test.ts", 15, [["number"], ["undefined"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "number");
    expect(reapplied(out)).toBe(out.text);
  });

  it("handles thisType annotations", () => {
    const out = applied(
      "function greet() { return this.text; }",
      [entry("test.ts", 15, [["Date"]], { thisType: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("this", "Date");
    expect(reapplied(out)).toBe(out.text);
  });

  it("does not block applying NEW entries on a partially-applied file", () => {
    // First apply only annotates `a`. Second run also has an entry for
    // `b` (a NEW observation that wasn't in the first types.json).
    // Idempotency must skip `a` (already annotated) but apply `b`.
    const first = applied("function foo(a, b) {}", [entry("test.ts", 14, [["number"]])]);
    expect(first).toAnnotate("a", "number");
    expect(first).toLeaveUntyped("b");

    // Pos for `b` in the MODIFIED source: original was pos 17, now
    // shifted to 25 due to ": number" insertion (8 chars).
    const second = applied(first.text, [
      entry("test.ts", 14, [["number"]]), // already applied — skipped
      entry("test.ts", 25, [["string"]]), // new — applied
    ]);
    expect(parseErrors(second)).toEqual([]);
    expect(second).toAnnotate("a", "number");
    expect(second).toAnnotate("b", "string");
  });

  it.todo(
    "(known limitation) idempotency on Bug-C-synthesized class-field entries. " +
      "Same pos-shift root cause as the multi-entry case above: when " +
      "field-decl pos shifts due to other applies, our naive pos-based " +
      "check misses it. Needs the same sidecar-manifest fix.",
  );
});

describe("apply — infer.ignoreExistingTypes", () => {
  // Divergence-measurement mode (ignore existing annotations):
  // when on, the idempotency check is bypassed so apply emits annotations
  // even at already-typed positions. Output may be syntactically invalid TS
  // (existing `: T` stays alongside the new one) — that's intentional;
  // the use case is grepping/diffing what ts-capture WOULD have emitted,
  // not producing clean rewrites. So the text is the claim.

  it("default behaviour unchanged: existing annotations are preserved", () => {
    const source = "function foo(a: number) {}";
    expect(applied(source, [entry("test.ts", 14, [["string"]])], ANY_NAME).text).toBe(source);
  });

  it("flag on: apply emits annotation despite existing one", () => {
    const source = "function foo(a: number) {}";
    const out = applied(
      source,
      [entry("test.ts", 14, [["string"]])],
      withInfer({ requireTypeRefInScope: false, ignoreExistingTypes: true }),
    );
    expect(out.text).toBe("function foo(a: string: number) {}");
  });
});

describe("apply — RewriteMostSpecificCommonBase (applier wiring)", () => {
  // The @sa chain collapse (rewriteCommonBase) and marker stripping
  // (stripAllChainMarkers) are unit-tested at the boundary in class-chain.spec.ts.
  // These e2e samples prove the applier wiring: markers are always stripped
  // before emit, the collapse is gated by the flag, and it reaches class unions
  // nested inside an object value via the recursive merge.
  it("always strips the @sa marker before emit, even with the flag off", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [["Cat /* @sa:Animal */"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "Cat");
    expect(out.text).not.toContain("@sa");
  });

  it("with the flag on — collapses a class union to its shared ancestor", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [["Cat /* @sa:Mammal|Animal */"], ["Dog /* @sa:Mammal|Animal */"]])],
      withInfer({ rewriteCommonBase: true, requireTypeRefInScope: false }),
    );
    expect(out).toAnnotate("a", "Mammal");
  });

  it("with the flag off — multiple classes stay a flat union (markers stripped)", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [["Cat /* @sa:Animal */"], ["Dog /* @sa:Animal */"]])],
      ANY_NAME,
    );
    expect(out).toAnnotate("a", "Cat | Dog");
  });

  it("collapses a class union nested inside an object value position", () => {
    const out = applied(
      "function foo(a) {}",
      [
        entry("test.ts", 14, [
          ["{ pet: Cat /* @sa:Animal */ }"],
          ["{ pet: Dog /* @sa:Animal */ }"],
        ]),
      ],
      withInfer({ rewriteCommonBase: true, requireTypeRefInScope: false }),
    );
    expect(out).toAnnotate("a", "{ pet: Animal }");
  });
});

describe("apply — skipRedundantAnnotations (applier wiring)", () => {
  // The syntactic inference (inferTypeFromInitializer) and the const/let/
  // readonly narrowing flag (buildInferableInfoMap) are unit-tested at the
  // boundary in initializer-inference.spec.ts. These e2e samples prove the
  // applier wiring: the suppression is gated on the flag, fires only on a
  // varDecl whose inferred type equals the emitted one, keeps the annotation
  // when the observation is wider, and never touches params / return types.
  const letX = (types: string[]) => [
    entry(
      "test.ts",
      5,
      types.map((t) => [t] as [string]),
      { varDecl: true },
    ),
  ];

  it("OFF (explicit) — `let x = 5` still gets `: number`", () => {
    const out = applied(
      "let x = 5;",
      letX(["number"]),
      withInfer({ requireTypeRefInScope: false, skipRedundantAnnotations: false }),
    );
    expect(out).toAnnotate("x", "number");
  });

  it("ON — `let x = 5` skips the redundant `: number`", () => {
    const out = applied(
      "let x = 5;",
      letX(["number"]),
      withInfer({ skipRedundantAnnotations: true }),
    );
    expect(out).toLeaveUntyped("x");
  });

  it("ON — keeps the annotation when the observed type is WIDER than the inferred one", () => {
    const out = applied(
      "let x = 5;",
      letX(["number", "string"]),
      withInfer({ skipRedundantAnnotations: true }),
    );
    expect(out).toAnnotate("x", "number | string");
  });

  it("ON — class field `x = 5` skips the redundant `: number`", () => {
    const out = applied(
      "class C { x = 5; }",
      [entry("test.ts", 11, [["number"]], { varDecl: true })],
      withInfer({ skipRedundantAnnotations: true }),
    );
    expect(out).toLeaveUntyped("x");
  });

  it("ON — a function param is NEVER suppressed (TS does not infer params)", () => {
    const out = applied(
      "function foo(a) { return a; }",
      [entry("test.ts", 14, [["number"]])],
      withInfer({ skipRedundantAnnotations: true }),
    );
    expect(out).toAnnotate("a", "number");
  });
});

describe("apply — preferNamedInScope same-file matching (applier wiring)", () => {
  // The same-file index build and the exact / subset rewrite are unit-tested at
  // the boundary in named-type-index.spec.ts. These e2e samples prove the
  // applier wiring: the substitution is gated by preferNamedInScope, and both
  // appliers emit the named form.
  const source = "interface Foo { a: number }\nfunction f(x) { return x; }";
  const shapeAtX = [entry("test.ts", 40, [["{ a: number }"]], {})];

  it("explicit OFF — the structural type stays structural", () => {
    const out = applied(
      source,
      shapeAtX,
      withInfer({ requireTypeRefInScope: false, preferNamedInScope: false }),
    );
    expect(out).toAnnotate("x", "{ a: number }");
  });

  it("ON — an exact same-file match substitutes the name", () => {
    const out = applied(source, shapeAtX, {
      infer: { ...INFER_DEFAULTS, preferNamedInScope: true },
    });
    expect(out).toAnnotate("x", { ref: "Foo" });
    expect(out).toTypeAs("x", "{ a: number }");
  });
});

describe("apply — requireTypeRefInScope (applier wiring)", () => {
  // The scope set (buildScopedTypeNames: imports, type-only imports, same-file
  // decls, ECMA-core allowlist) and the all-refs-in-scope check
  // (allTypeRefsInScope, incl. generic / union members) are unit-tested at the
  // boundary in scope-reachability.spec.ts. These e2e samples prove the applier
  // wiring: an out-of-scope ctor name is skipped (unless the flag is off), an
  // imported name lands, and both appliers enforce the same check.
  const source = "function f(x) { return x; }";
  const loggerAtX = [entry("test.ts", 12, [["AppLogger"]], {})];

  it("ON by default — skips an annotation referencing an unimported type", () => {
    expect(applied(source, loggerAtX, {})).toLeaveUntyped("x");
  });

  it("OFF — emits the name even when unreachable (back-compat opt-out)", () => {
    const out = applied(source, loggerAtX, ANY_NAME);
    expect(out).toAnnotate("x", { ref: "AppLogger" });
  });

  it("ON — keeps the annotation when the name is imported", () => {
    const imported = "import { AppLogger } from './AppLogger';\nfunction f(x) { return x; }";
    const out = applied(imported, [entry("test.ts", 53, [["AppLogger"]], {})]);
    expect(out).toAnnotate("x", { ref: "AppLogger" });
  });
});

describe("apply — TypeChecker-aware scope (applier wiring)", () => {
  // buildScopedTypeNamesViaTypeChecker (DOM ambients, file-not-in-program →
  // undefined, ctor arity) is unit-tested at the boundary in
  // scope-reachability.spec.ts. These e2e samples prove the applier wiring: with
  // a Program it uses the TypeChecker scope (lighting up DOM + cross-file
  // imports), and without one it falls back to the text-level scan.
  it("ON — a DOM type (HTMLElement) is in scope via the TypeChecker", () => {
    const out = applied(
      "function f(x) { return x; }",
      [entry("test.ts", 12, [["HTMLElement"]], {})],
      {
        project: true,
      },
    );
    expect(out).toAnnotate("x", { ref: "HTMLElement" });
  });

  it("ON — a direct cross-file import resolves to in-scope", () => {
    const source = "import { InnerType } from './inner.js';\nfunction f(x) { return x; }";
    const out = applied(source, [entry("test.ts", 52, [["InnerType"]], {})], {
      project: true,
      files: { "inner.ts": "export interface InnerType { a: number; }" },
    });
    expect(out).toAnnotate("x", { ref: "InnerType" });
    expect(out).toTypeAs("x", "{ a: number }");
  });

  it("ON — without a Program, falls back to the text-level scan (DOM skipped)", () => {
    const out = applied("function f(x) { return x; }", [
      entry("test.ts", 12, [["HTMLElement"]], {}),
    ]);
    expect(out).toLeaveUntyped("x");
  });
});

describe("apply — preferNamedInScope cross-file (applier wiring)", () => {
  // The cross-file index build (buildNamedTypeIndex with a Program — imports,
  // re-export barrels, generic-skip, same-file-collision precedence) is
  // unit-tested at the boundary in named-type-index.spec.ts. These e2e samples
  // prove the applier wiring: with a Program an imported interface name is
  // substituted; without one it falls back to same-file-only (no match).
  const source = "import { BookingState } from './state.js';\nfunction subscribe(s) { return s; }";
  const shapeAtS = [entry("test.ts", 63, [["{ activeCustomer: string, uniqueId: string }"]], {})];
  const files = {
    "state.ts": "export interface BookingState { activeCustomer: string; uniqueId: string; }",
  };

  it("ON + Program — an imported interface name substitutes the structural type", () => {
    const out = applied(source, shapeAtS, { project: true, files });
    expect(out).toAnnotate("s", { ref: "BookingState" });
  });

  it("ON without a Program — falls back to same-file only (no cross-file match)", () => {
    const out = applied(source, shapeAtS, { files });
    expect(out).toAnnotate("s", "{ activeCustomer: string; uniqueId: string }");
  });
});

describe("apply — paren-less arrow wrap is per-position", () => {
  // Sibling-entry coordination: the applier derives `parens` from
  // source when `opts.arrow && !opts.parens`. But when the arrow-entry
  // itself is SKIPPED (requireTypeRefInScope, preferNamedInScope
  // substitution to unreachable name) and a sibling returnType-entry
  // lands at the same pos without `opts.arrow`, the wrap would be
  // missed → `state: T => body` (TS1005). detectParenLessArrowParam
  // is hoisted out of the per-entry gate and computed once per pos;
  // any landing entry triggers wrap. The parens are text; the result
  // parsing with the annotation in place is the claim.

  it("returnType-entry alone at paren-less arrow pos: wrap still happens", () => {
    // After preferNamedInScope rejects the arrow-entry, only the
    // returnType lands. Post-undefined-→-void widening, the lone
    // `undefined` return-observation is emitted as `: void`
    // (idiomatic for callbacks that don't intentionally return).
    const out = applied("store.subscribe(state => handle(state));", [
      entry("test.ts", 21, [["undefined"]], { returnType: true }),
    ]);
    expect(parseErrors(out)).toEqual([]);
    expect(firstArrow(out).type?.getText(out.sf)).toBe("void");
    expect(out.text).toBe("store.subscribe((state): void => handle(state));");
  });

  it("arrow + returnType both land at paren-less pos: wrap once, both annotations land", () => {
    const out = applied("arr.map(x => x * 2);", [
      entry("test.ts", 9, [["number"]], { arrow: true, parens: [8, 9] }),
      entry("test.ts", 9, [["number"]], { returnType: true }),
    ]);
    expect(parseErrors(out)).toEqual([]);
    expect(out).toAnnotate("x", "number");
    expect(firstArrow(out).type?.getText(out.sf)).toBe("number");
    expect(out.text).toBe("arr.map((x: number): number => x * 2);");
  });

  it("arrow-entry alone at paren-less pos: regression guard", () => {
    const out = applied("arr.map(x => x * 2);", [
      entry("test.ts", 9, [["number"]], { arrow: true, parens: [8, 9] }),
    ]);
    expect(out).toAnnotate("x", "number");
    expect(out.text).toBe("arr.map((x: number) => x * 2);");
  });
});

describe("apply — paren-less arrow param wrapping", () => {
  // Without proper handling, an applier inserts `: T` after a
  // paren-less arrow param's name without restoring the wrapping
  // parens, producing `state: undefined => body` — TS1005. The
  // transformer normally sets `opts.parens` for these cases, but if
  // `parens` is missing (stale types.json, hand-synthesized entry),
  // the applier derives paren-less detection from source when
  // `opts.arrow` is set without `parens`.
  it.each([
    [
      "an entry with arrow:true but no parens",
      "arr.map(x => x * 2)",
      9,
      "x",
      "arr.map((x: number) => x * 2)",
    ],
    [
      "a paren-less arrow in callback context",
      "store.subscribe(state => handle(state));",
      21,
      "state",
      "store.subscribe((state: number) => handle(state));",
    ],
    [
      "an arrow already wrapped in parens (no double-wrap)",
      "arr.map((x) => x * 2)",
      10,
      "x",
      "arr.map((x: number) => x * 2)",
    ],
    [
      "`const f = x => body` (assigned paren-less)",
      "const f = x => x * 2;",
      11,
      "x",
      "const f = (x: number) => x * 2;",
    ],
  ])("%s", (_, source, pos, name, expected) => {
    const out = applied(source, [entry("test.ts", pos, [["number"]], { arrow: true })]);
    expect(out).toAnnotate(name, "number");
    expect(out.text).toBe(expected);
  });
});

describe("apply — honorAsCasts", () => {
  // When the user writes `const w = window as MyWindow`, ts-capture
  // walking the runtime value and emitting a 6KB structural type
  // fights the user's intent. The transformer marks such entries
  // `hasAsCast: true`; apply consults `infer.honorAsCasts` (default
  // ON) and skips the annotation.
  const cast = [entry("test.ts", 7, [["{ a: number }"]], { varDecl: true, hasAsCast: true })];

  it("ON by default — entry with hasAsCast is skipped", () => {
    expect(applied("const w = window as MyWindow;", cast, ANY_NAME)).toLeaveUntyped("w");
  });

  it("OFF — entry with hasAsCast still gets annotated (back-compat opt-out)", () => {
    const out = applied("const w = window as MyWindow;", cast, withInfer({ honorAsCasts: false }));
    expect(out).toAnnotate("w", "{ a: number }");
  });

  it("ON — varDecl WITHOUT hasAsCast still gets annotated normally", () => {
    const out = applied(
      "const x = 5;",
      [entry("test.ts", 7, [["number"]], { varDecl: true })],
      withInfer({ requireTypeRefInScope: false, skipRedundantAnnotations: false }),
    );
    expect(out).toAnnotate("x", "number");
  });
});

// Return types with sole-observation `undefined` widen to `void`. Bodies
// without an explicit return (event handlers, side-effect callbacks) are
// typed `void` by TS at the callsite; emitting `: undefined` would make
// the callsite reject under strict mode when the body is
// `console.log(...)` or another expression-statement.
describe("apply — returnType undefined widens to void (applier wiring)", () => {
  // The union-keeps-undefined / async-Promise<void> / non-returnType variants
  // are unit-tested at the boundary in compute-annotation.spec.ts. This e2e
  // sample proves the applier inserts `: void` for a sole-undefined return.
  it("single undefined observation on returnType emits `void`", () => {
    const out = applied(
      "store.subscribe(state => handle(state));",
      [entry("test.ts", 21, [["undefined"]], { returnType: true })],
      ANY_NAME,
    );
    expect(firstArrow(out).type?.getText(out.sf)).toBe("void");
  });
});

// Opt-in diagnostic markers for approximation fallbacks. A marker is a
// comment beside the type, so the text is the claim.
describe("apply — emitDiagnosticComments", () => {
  const DIAGNOSE = withInfer({ requireTypeRefInScope: false, emitDiagnosticComments: true });
  const genericFn: CollectedTypeInfo = [
    ["test.ts", 15, [["(x: unknown) => unknown", undefined, "generic-fn"]], {}],
  ];

  it("OFF by default — useless arrows are suppressed", () => {
    // With diagnostic comments OFF, a sole (x: unknown) => unknown
    // observation is treated as noise and produces no annotation.
    expect(applied("function foo(cb) {}", genericFn, ANY_NAME)).toLeaveUntyped("cb");
  });

  it("ON — generic-fn reason produces `/* @ts-capture:generic-fn */` marker", () => {
    const out = applied("function foo(cb) {}", genericFn, DIAGNOSE);
    expect(out).toAnnotate("cb", "(x: unknown) => unknown");
    expect(out.text).toBe(
      "function foo(cb: (x: unknown) => unknown /* @ts-capture:generic-fn */) {}",
    );
  });

  it("ON — shape-capped reason produces `/* @ts-capture:shape-capped */` marker", () => {
    const out = applied(
      "let store = makeStore();",
      [["test.ts", 9, [["Record<string, unknown>", undefined, "shape-capped"]], { varDecl: true }]],
      DIAGNOSE,
    );
    expect(out.text).toContain(": Record<string, unknown> /* @ts-capture:shape-capped */");
  });

  it("ON — entry with no reason produces no marker", () => {
    const out = applied("function foo(a) {}", [entry("test.ts", 14, [["string"]])], DIAGNOSE);
    expect(out).toAnnotate("a", "string");
    expect(out.text).not.toContain("@ts-capture");
  });

  it("first-wins on multi-observation entries", () => {
    // Union of two observations — only one has a reason. The reason
    // wins (we report any approximation in the entry, even if some
    // observations were precise).
    const out = applied(
      "function foo(a) {}",
      [
        [
          "test.ts",
          14,
          [
            ["string", undefined],
            ["(x: unknown) => unknown", undefined, "generic-fn"],
          ],
          {},
        ],
      ],
      DIAGNOSE,
    );
    expect(out.text).toContain("/* @ts-capture:generic-fn */");
  });
});

describe("apply — generic ctor arity expansion (applier wiring)", () => {
  // expandCtorArity and buildCtorArityMap are unit-tested at the boundary in
  // scope-reachability.spec.ts. These e2e samples prove the applier wires the
  // Program-derived arity map through expandCtorArity to fill a bare generic
  // class name (and does not double-expand an already-parameterized one).

  // Arity expansion exists because bare `Container` is a type error when the
  // class requires an argument — the only valid forms are `Container<unknown>`
  // or no annotation. The vacuity guard now chooses the second: a container
  // whose payload is unknown is not worth writing, same as `Promise<unknown>`.
  // The expansion still runs, and still shows up under `emitDiagnosticComments`.
  it("suppresses a bare generic class name rather than expanding it to Name<unknown>", () => {
    const source =
      "class Container<T> { constructor(public value: T) {} }\nfunction f(x) { return x; }";
    const out = applied(source, [entry("test.ts", 67, [["Container"]], {})], {
      project: true,
    });
    expect(out).toLeaveUntyped("x");
  });

  it("does not double-expand an already-parameterized generic", () => {
    const source = "class Container<T> {}\nfunction f(x) { return x; }";
    // Payload is `string`, not `unknown`: the subject here is generic expansion,
    // and a vacuous type would be dropped before it got that far.
    const out = applied(source, [entry("test.ts", 34, [["Container<string>"]], {})], {
      project: true,
    });
    expect(out).toAnnotate("x", "Container<string>");
  });
});

// --- Per-file ignore via ignoreFiles config ----------------------------
// Some files are predictably noisy targets — loggers that observe the
// whole app state, generated code, third-party adapters with their own
// type contracts. Let users exclude them from apply via a regex list
// instead of sprinkling `// @ts-capture-ignore` throughout.
describe("ignoreFiles config skips whole files", () => {
  const source = "const v = make();";
  const vAt = (file: string) => [
    entry(file, source.indexOf("const v ") + "const v".length, [["string"]], { varDecl: true }),
  ];
  const inFile = (filename: string, ignoreFiles?: RegExp[]) =>
    applied(source, vAt(filename), {
      ...ANY_NAME,
      filename,
      ...(ignoreFiles ? { ignoreFiles } : {}),
    });

  it("returns source unchanged when filename matches any ignore pattern", () => {
    expect(inFile("src/utils/logger.ts", [/logger\.ts$/])).toLeaveUntyped("v");
  });

  it("annotates files that do not match any ignore pattern", () => {
    expect(inFile("src/utils/helper.ts", [/logger\.ts$/])).toAnnotate("v", "string");
  });

  it("skips when ANY of multiple patterns matches", () => {
    expect(inFile("generated/Schema.ts", [/logger\.ts$/, /\/generated\//])).toLeaveUntyped("v");
  });

  it("no-op when ignoreFiles is omitted", () => {
    expect(inFile("src/utils/logger.ts")).toAnnotate("v", "string");
  });
});

// --- @ts-capture-ignore comment opts out of annotation -----------------
// Users sometimes know better than the apply heuristic. `// @ts-capture-ignore`
// on the line preceding a declaration tells apply to leave that position
// alone. Matches the prior-art conventions of `// eslint-disable-next-line`
// and `// @ts-ignore` so the marker is immediately recognisable.
describe("@ts-capture-ignore comment skip", () => {
  const vIn = (source: string) => [
    entry("test.ts", source.indexOf("const v ") + "const v".length, [["string"]], {
      varDecl: true,
    }),
  ];

  it("skips varDecl annotation when @ts-capture-ignore comment is on prior line", () => {
    const source = "// @ts-capture-ignore\nconst v = make();";
    expect(applied(source, vIn(source), ANY_NAME)).toLeaveUntyped("v");
  });

  it("still annotates when no ignore comment is present", () => {
    const source = "const v = make();";
    expect(applied(source, vIn(source), ANY_NAME)).toAnnotate("v", "string");
  });

  it("recognises the marker via leading-comment attachment (not just text scan)", () => {
    // Multi-line comment form on the immediately-preceding line.
    const source = "/* @ts-capture-ignore */\nconst v = make();";
    expect(applied(source, vIn(source), ANY_NAME)).toLeaveUntyped("v");
  });

  it("ignore comment further up the file does not affect distant positions", () => {
    const source = "// @ts-capture-ignore\nconst skipped = a();\n\nconst kept = b();";
    const posKept = source.indexOf("const kept ") + "const kept".length;
    const out = applied(
      source,
      [entry("test.ts", posKept, [["number"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("kept", "number");
  });

  it("skips function param annotation when ignore comment is on prior line", () => {
    const source = "// @ts-capture-ignore\nfunction foo(a) {}";
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("(a") + 2, [["string"]])],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("a");
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
    const out = applied(
      "const v = maybe() ?? undefined;",
      [entry("test.ts", 7, [["undefined"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("v");
  });

  it("skips a union-producing site on a single non-undefined observation (one branch seen)", () => {
    const out = applied(
      "let mainId = flag ? compute() : undefined;",
      [entry("test.ts", 10, [["number"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("mainId");
  });

  it("STILL annotates a genuine multi-type union", () => {
    const out = applied(
      "const v = maybe() ?? undefined;",
      [entry("test.ts", 7, [["undefined"], ["string"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("v", "string | undefined");
  });

  it("STILL annotates a non-union initializer like `arr.map(...)`", () => {
    const out = applied(
      "let v = arr.map(x => x.id);",
      [entry("test.ts", 5, [["number[]"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("v", "number[]");
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
    const out = applied(
      "const v = getString(key);",
      [entry("test.ts", 7, [["undefined"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("v");
  });

  it("STILL annotates a literal `= undefined` initializer", () => {
    const out = applied(
      "let v = undefined;",
      [entry("test.ts", 5, [["undefined"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("v", "undefined");
  });

  it("STILL annotates an opaque call when the observation is NOT undefined", () => {
    const out = applied(
      "const v = getString(key);",
      [entry("test.ts", 7, [["string"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("v", "string");
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
    const out = applied(
      source,
      [entry("test.ts", pos, [["{ a: number, b: string }"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("v", { ref: "Foo" });
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
    const out = applied(
      source,
      [entry("test.ts", pos, [["Promise<{ id: number, name: string }>"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("v", "Promise<Resp>");
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
    const out = applied(
      source,
      [
        entry("test.ts", source.indexOf(")") + 1, [["Promise<number>"]], {
          returnType: true,
          async: true,
        }),
      ],
      ANY_NAME,
    );
    expect(out).toAnnotate({ returnOf: "f" }, "Promise<number>");
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
    const out = applied(
      source,
      [
        entry("test.ts", pos, [["{ active: boolean, id: number }"]], {
          arrow: true,
          parens: [pos - "product".length, pos],
        }),
      ],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("product");
  });

  it("skips a structural returnType annotation inside an array callback", () => {
    const source = "const r = arr.map(p => p.price);";
    const out = applied(
      source,
      [
        entry("test.ts", source.indexOf("p ") + 1, [["{ campaignId: number, vat: number }"]], {
          returnType: true,
        }),
      ],
      ANY_NAME,
    );
    expect(firstArrow(out).type).toBeUndefined();
  });

  it("STILL annotates a primitive returnType inside an array callback", () => {
    const source = "const r = arr.map(p => p.id);";
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("p ") + 1, [["number"]], { returnType: true })],
      ANY_NAME,
    );
    expect(firstArrow(out).type?.getText(out.sf)).toBe("number");
  });

  it("STILL annotates a structural param on a free arrow (not an array callback)", () => {
    const source = "const fn = (x) => x.id;";
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("(x)") + 2, [["{ id: number }"]], { arrow: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("x", "{ id: number }");
  });
});

// --- outer-annotation skip: generic context & explicit type-args -------
// These samples prove the applier drops the outer annotation inside a generic enclosing function
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
    const out = applied(
      source,
      [entry("test.ts", pos, [["number[]|undefined"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("v");
  });

  it("skips a var-decl annotation when the initializer call has explicit type arguments", () => {
    const out = applied(
      "const data = parseModelResponse<MyType>(json);",
      [entry("test.ts", 10, [["{ a: string, b: number }"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("data");
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
    const out = applied(
      "let s = giant();",
      [entry("test.ts", 5, [[makeLongShape(500)]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("s");
  });

  it("falls back to common base when a class-union exceeds the cap", () => {
    const classes = Array.from(
      { length: 20 },
      (_, i) => `LongClassNameNumber${i} /* @sa:Mammal|Animal */`,
    );
    const out = applied(
      "let pet = wild();",
      [
        entry(
          "test.ts",
          7,
          classes.map((c) => [c] as [string]),
          { varDecl: true },
        ),
      ],
      withInfer({ requireTypeRefInScope: false, maxAnnotationChars: 100 }),
    );
    expect(out).toAnnotate("pet", "Mammal");
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
  // collapsed shape through a varDecl.
  it("merges same-keyset object union into field-level unions", () => {
    const cartesian =
      "Array<{ a: null, b: null } | { a: null, b: number } | { a: number, b: null } | { a: number, b: number }>";
    const out = applied(
      "let xs = list();",
      [entry("test.ts", 6, [[cartesian]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("xs", "{ a: number | null; b: number | null }[]");
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
    const out = applied(
      "let xs = list();",
      [entry("test.ts", 6, [["unknown[]"], ["string[]"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("xs", "string[]");
  });

  it("writes no annotation when an object field's value is unknown[]", () => {
    const out = applied(
      "const colorMap = build();",
      [
        entry("test.ts", 14, [["{ outline: unknown[], primary: string[], white: string[] }"]], {
          varDecl: true,
        }),
      ],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("colorMap");
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
    const out = applied(
      "let cb = registerHandler();",
      [entry("test.ts", 6, [["(arg: unknown) => unknown"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("cb");
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
    const out = applied(source, [entry("test.tsx", 68, [["boolean"]], { varDecl: true })], {
      filename: "test.tsx",
    });
    expect(out.text).toBe(source);
  });

  it("does not annotate position inside single-line import", () => {
    const source = "import { foo } from './bar';\nconst x = true;";
    // Offset 7 is inside `import { foo }`.
    const out = applied(source, [entry("test.ts", 7, [["string"]], { varDecl: true })]);
    expect(out.text).toBe(source);
  });

  it("still annotates legitimate varDecl elsewhere in same file", () => {
    // Defensive: the new guard must be narrow — varDecls outside imports
    // are still annotated as before.
    const source = "import { foo } from './bar';\nconst x = true;";
    const declStart = source.indexOf("const x") + "const x".length;
    const out = applied(
      source,
      [entry("test.ts", declStart, [["boolean"]], { varDecl: true })],
      withInfer({ skipRedundantAnnotations: false }),
    );
    expect(out).toAnnotate("x", "boolean");
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
    const out = applied(source, [entry("test.tsx", 12, [["string"]], { varDecl: true })], {
      filename: "test.tsx",
    });
    expect(out.text).toBe(source);
  });

  it("does not annotate offset between `export` keyword and `const`", () => {
    const source = "export const x = 1;\n";
    // Position 6 == end of "export" keyword.
    const out = applied(source, [entry("test.ts", 6, [["number"]], { varDecl: true })]);
    expect(out.text).toBe(source);
  });

  it("still annotates at the correct identifier-end position", () => {
    // Use a non-arrow RHS to avoid colliding with the existing
    // function-expression skip rule.
    const source = "export const taskCount = 5;\n";
    const declEnd = source.indexOf("taskCount") + "taskCount".length;
    const out = applied(
      source,
      [entry("test.ts", declEnd, [["number"]], { varDecl: true })],
      withInfer({ skipRedundantAnnotations: false }),
    );
    expect(out).toAnnotate("taskCount", "number");
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
    const out = applied(
      source,
      [
        entry("t.ts", declEnd, [["(request: eObject: {request: e: unknown}) => unknown"]], {
          varDecl: true,
        }),
      ],
      ANY_NAME,
    );
    expect(out).toLeaveUntyped("handler");
    expect(parseErrors(out)).toEqual([]);
  });

  it("still emits when the type is parseable", () => {
    const source = "const count = compute();\n";
    const declEnd = source.indexOf("count") + "count".length;
    const out = applied(
      source,
      [entry("t.ts", declEnd, [["number"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("count", "number");
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
  const TSX: AppliedOptions = { filename: "t.tsx" };

  it("rejects offset that lands at a JSX attribute name end", () => {
    const source = `function C() { return <Box display="flex" />; }\n`;
    const attrEnd = source.indexOf("display") + "display".length;
    const out = applied(source, [entry("t.tsx", attrEnd, [["string"]], { varDecl: true })], TSX);
    expect(out.text).toBe(source);
  });

  it("rejects offset that lands at a JSX component name end", () => {
    const source = `function C() { return <CardActions sx={{}} />; }\n`;
    const compEnd = source.indexOf("CardActions") + "CardActions".length;
    const out = applied(
      source,
      [entry("t.tsx", compEnd, [["() => unknown"]], { varDecl: true })],
      TSX,
    );
    expect(out.text).toBe(source);
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
    const out = applied(
      source,
      [entry("t.tsx", declEnd, [["{ later: number }"]], { varDecl: true })],
      {
        ...TSX,
        infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: false },
      },
    );
    expect(out).toAnnotate("display", "{ later: number }");
    // The JSX attribute must not have been touched.
    expect(nodesOf(out, ts.isJsxAttribute)[0].getText(out.sf)).toBe('display="flex"');
  });
});

describe("extension: skip outer varDecl annotation when RHS is an object of methods", () => {
  // The heuristics that once skipped method-bearing objects, spread RHSs,
  // `return undefined` branches, satisfies contexts and useless Promises were
  // removed: each produced a type error the oracle catches directly, and the
  // oracle-based regression tests live in apply-types-cst.spec.ts under
  // "TypeChecker verify integration". These are the controls: the plain cases
  // each heuristic had to leave alone must still be annotated.

  it("STILL annotates a plain-data object (no method properties)", () => {
    const source = "const config = { url: '/api', timeout: 5000 };\n";
    const declEnd = source.indexOf("config") + "config".length;
    const out = applied(
      source,
      [entry("t.ts", declEnd, [["{ url: string, timeout: number }"]], { varDecl: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("config", "{ url: string; timeout: number }");
  });

  it("STILL annotates plain object with no useless-arrow methods", () => {
    const source = "const result = compute();\n";
    const declEnd = source.indexOf("result") + "result".length;
    const out = applied(
      source,
      [
        entry(
          "t.ts",
          declEnd,
          [["{ score: number, label: string, format: (n: number) => string }"]],
          { varDecl: true },
        ),
      ],
      ANY_NAME,
    );
    expect(out).toAnnotate(
      "result",
      "{ score: number; label: string; format: (n: number) => string }",
    );
  });

  it("STILL annotates returnType when all branches return the same shape", () => {
    const source = `function compute(x: number) {
    return x * 2;
}
`;
    const out = applied(
      source,
      [entry("t.ts", source.indexOf(")") + 1, [["number"]], { returnType: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate({ returnOf: "compute" }, "number");
  });

  it("STILL annotates an arrow outside any satisfies / typed context", () => {
    const source = "const compute = (x) => x * 2;\n";
    const out = applied(
      source,
      [entry("t.ts", source.indexOf("x)") + 1, [["number"]], { arrow: true })],
      ANY_NAME,
    );
    expect(out).toAnnotate("x", "number");
  });

  it("STILL annotates returnType when emitted is a useful Promise<T>", () => {
    const source = `const fetchUser = () => fetchAPI();\n`;
    const paramsClose = source.indexOf("()") + 2;
    const out = applied(
      source,
      [
        entry("t.ts", paramsClose, [["Promise<{ id: number, name: string }>"]], {
          returnType: true,
          async: true,
          fnRetPos: paramsClose,
        }),
      ],
      ANY_NAME,
    );
    expect(out).toAnnotate({ returnOf: "fetchUser" }, "Promise<{ id: number; name: string }>");
  });
});

describe("irDedupUnion fn-paren at apply boundary", () => {
  // The `union-member` SerializeCtx wraps fn types in parens when they appear
  // as union members in IR. `irDedupUnion` calls `serializeType` at the
  // default `top` context and returns a `string[]`; the outer caller then
  // joins those strings with `|`, which would reintroduce the precedence
  // ambiguity: `(a: string) => number|string` parses as a function returning
  // `number | string`.
  it("wraps fn members in parens when joined with non-fn members at the apply boundary", () => {
    // Two fn observations where the wider-param fn is subsumed by the
    // narrower one (contravariant param: `string|number` ⊆ `string` in
    // fn-subtype terms — fewer-input fn is the subtype). A plain
    // `string` observation is also in the union. After irDedupUnion
    // drops the broader fn and re-serializes, the kept members are
    // [(a: string) => number, string].
    const out = applied(
      "function foo(a) {}",
      [
        entry("test.ts", 14, [
          ["(a: string | number) => number"],
          ["(a: string) => number"],
          ["string"],
        ]),
      ],
      ANY_NAME,
    );
    // Read back as a union of a function and a string, not as a function
    // returning a union.
    expect(out).toAnnotate("a", "((a: string) => number) | string");
  });
});

describe("apply — lub fallback (applier wiring)", () => {
  // The bail / structural-recovery / disjoint→unknown / legacy-succeeds variants
  // are unit-tested at the boundary in type-merge.spec.ts. This e2e sample proves
  // the applier-level wiring: disjoint shapes that lub collapses to `unknown` get
  // the polymorphic-position diagnostic marker when diagnostics are enabled.
  it("(lubFallback on + diagnostic comments) disjoint shapes get polymorphic-position marker", () => {
    const out = applied(
      "function foo(a) {}",
      [entry("test.ts", 14, [["{ a: number }"], ["{ b: string }"]])],
      withInfer({ requireTypeRefInScope: false, lubFallback: true, emitDiagnosticComments: true }),
    );
    expect(out).toAnnotate("a", "unknown");
    expect(out.text).toContain("unknown /* @ts-capture:polymorphic-position */");
  });
});

describe("apply — built-in shape recognition (applier wiring)", () => {
  // The Promise / Map / disabled / missing-key variants are unit-tested at the
  // boundary in type-merge.spec.ts. This e2e sample proves the applier emits the
  // recognized named ref through a param annotation.
  // `Promise<unknown>` names the container and discards the payload, so the
  // vacuity guard suppresses it by default. Diagnostic mode is the documented
  // escape — users who turn it on are asking to see where coverage is thin —
  // and it keeps this test on its actual subject: that the recognized named
  // ref reaches the applier at all.
  const promiseShape = [
    entry("test.ts", 14, [["{ then: (cb: unknown) => unknown, catch: (cb: unknown) => unknown }"]]),
  ];

  it("rewrites Promise structural shape to Promise<unknown> (diagnostic mode)", () => {
    const out = applied(
      "function foo(a) {}",
      promiseShape,
      withInfer({ requireTypeRefInScope: false, emitDiagnosticComments: true }),
    );
    expect(out).toAnnotate("a", "Promise<unknown>");
  });

  it("suppresses the recognized ref by default — it describes no payload", () => {
    expect(applied("function foo(a) {}", promiseShape, ANY_NAME)).toLeaveUntyped("a");
  });
});

describe("ApplyTelemetry", () => {
  // Counters mutate in place; the caller (cmdApply or a test) allocates
  // one telemetry object and threads it through every apply call.

  it("counts emit + idempotent + total on a mixed run", () => {
    const typeInfo = [entry("test.ts", 14, [["string"]])];
    const t = newApplyTelemetry();
    applied("function foo(a) {}", typeInfo, { ...ANY_NAME, telemetry: t });
    expect(t.totalEntries).toBe(1);
    expect(t.emitted).toBe(1);
    expect(t.idempotent).toBe(0);

    // Re-apply on the now-typed source: the same entry hits the
    // idempotent skip.
    const t2 = newApplyTelemetry();
    applied("function foo(a: string) {}", typeInfo, { ...ANY_NAME, telemetry: t2 });
    expect(t2.totalEntries).toBe(1);
    expect(t2.idempotent).toBe(1);
    expect(t2.emitted).toBe(0);
  });

  it("counts positionMismatch when offset is stale", () => {
    // Source has `foo(a)` but our typeInfo points at pos 99 — past EOF.
    const t = newApplyTelemetry();
    applied("function foo(a) {}", [entry("test.ts", 99, [["string"]])], {
      ...ANY_NAME,
      telemetry: t,
    });
    expect(t.totalEntries).toBe(1);
    expect(t.emitted).toBe(0);
    expect(t.positionMismatch).toBe(1);
  });
});
