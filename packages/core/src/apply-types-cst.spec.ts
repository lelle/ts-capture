import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DiscoveredType } from "./collector-contract.js";
import type { CollectedTypeEntry, CollectedTypeInfo, SourceLocation } from "./type-collector.js";

import { applyTypesToFileCst } from "./apply-types-cst.js";
import {
  createProjectVerificationContext,
  createVerificationContext,
} from "./apply-types-verify.js";
import { applyTypesToFile } from "./apply-types.js";
import { INFER_DEFAULTS } from "./configuration.js";

type LooseTypeTuple =
  [string | undefined] | [string | undefined, SourceLocation | undefined] | DiscoveredType;

// Helper: create a single param type-info entry. Accepts loose 1/2/3-tuple
// inputs and pads to the canonical 3-tuple shape so call sites can keep
// using `[["string"]]` without per-test boilerplate.
function entry(
  filename: string,
  offset: number,
  types: Array<LooseTypeTuple>,
  opts = {},
): CollectedTypeEntry {
  const normalized = types.map((t): DiscoveredType => [t[0], t[1] ?? undefined, t[2]]);
  return [filename, offset, normalized, opts];
}

describe("applyTypesToFileCst — param annotations via AST lookup", () => {
  // The spike's narrow scope: function parameters get routed through
  // the AST-aware path. Tests check parity with the offset-based
  // applier on the cases the spike handles, plus the AST-native
  // idempotency that comes for free.

  it("annotates a single param the same as the offset-based applier", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe("function foo(a: string) {}");
  });

  it("annotates multiple params the same as the offset-based applier", () => {
    const source = "function foo(a, b, c) { return a; }";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 14, [["number"]]),
      entry("test.ts", 17, [["string"]]),
      entry("test.ts", 20, [["boolean"]]),
    ];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("optional param: AST honours questionToken (no `source[pos-1] === '?'` reliance)", () => {
    const source = "function foo(a?) {}";
    // pos accounts for the `?`: name.end (14) + 1 = 15
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 15, [["number"], ["undefined"]])];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("function foo(a?: number) {}");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("idempotency: re-apply on already-annotated param is a no-op", () => {
    const source = "function foo(a: string) {}";
    // Same pos as before annotation — but the AST now sees `a: string`,
    // so paramSites doesn't index this position. CST applier silently
    // skips, no offset-string matching needed.
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"]])];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(source);
  });

  it("union type: same join character as offset-based applier (`|`)", () => {
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["string"], ["number"]])];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("class method param annotated correctly", () => {
    const source = "class C { foo(x) { return x; } }";
    // class C { foo(x) { ... } } — pos of `x`'s name end:
    const pos = source.indexOf("x)") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]])];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toContain("foo(x: number)");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("constructor param with parameter property modifier (public x)", () => {
    const source = "class C { constructor(public x) {} }";
    const pos = source.indexOf("x)") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]])];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toContain("public x: number");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("destructure-pattern params (object binding) routed through CST: name.end works for BindingPattern too", () => {
    // BindingPattern.end is after the closing `}`. The CST path used
    // to skip non-Identifier params; now the visitor indexes them too
    // and the apply lands `: T` at that position. Output matches the
    // offset-based applier byte-for-byte.
    const source = "function foo({ a, b }) { return a; }";
    const pos = source.indexOf(")");
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["{ a: number, b: number }"]])];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("{ a, b }: { a: number, b: number }");
  });

  it("destructure-pattern params (array binding): same path", () => {
    const source = "function foo([a, b]) { return a + b; }";
    const pos = source.indexOf(")");
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["[number, number]"]])];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("[a, b]: [number, number]");
  });

  it("mixed entries (param + varDecl, both via CST): output matches offset-based applier", () => {
    // Both entries route through CST now. Output must be
    // byte-identical to the all-offset-based path.
    const source = "let x = 5;\nfunction foo(a) { return a; }";
    const xPos = source.indexOf("x ") + 1;
    const aPos = source.indexOf("a)") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", xPos, [["number"]], { varDecl: true }),
      entry("test.ts", aPos, [["string"]]),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("let x: number = 5");
    expect(cst).toContain("function foo(a: string)");
  });

  it("mixed: param BEFORE varDecl in source — varDecl pos rebased correctly", () => {
    // Order matters for the rebase: when CST insertion is at a
    // smaller offset than the pass-through entry, the pass-through
    // pos must shift forward by the inserted length.
    const source = "function foo(a) { return a; }\nlet x = 5;";
    const aPos = source.indexOf("a)") + 1;
    const xPos = source.indexOf("x ") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", aPos, [["string"]]),
      entry("test.ts", xPos, [["number"]], { varDecl: true }),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("function foo(a: string)");
    expect(cst).toContain("let x: number = 5");
  });

  it("mixed: varDecl BEFORE param in source — param pos unaffected by varDecl going first", () => {
    // varDecl is in passThrough; CST runs first (params), then offset-
    // based applies varDecl on the modified source. varDecl's pos was
    // < param's pos, so rebase doesn't shift it. The offset-based pass
    // sees the source with the param annotation already applied; that
    // doesn't perturb the varDecl pos.
    const source = "let x = 5;\nfunction foo(a) { return a; }";
    const xPos = source.indexOf("x ") + 1;
    const aPos = source.indexOf("a)") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", xPos, [["number"]], { varDecl: true }),
      entry("test.ts", aPos, [["string"]]),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("two params (both CST) plus varDecl (offset-based): all three correctly placed", () => {
    const source = "let x = 5;\nfunction foo(a, b) { return a + b; }";
    const xPos = source.indexOf("x ") + 1;
    const aPos = source.indexOf("(a") + 2;
    const bPos = source.indexOf(", b") + 3;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", xPos, [["number"]], { varDecl: true }),
      entry("test.ts", aPos, [["number"]]),
      entry("test.ts", bPos, [["number"]]),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("let x: number = 5");
    expect(cst).toContain("function foo(a: number, b: number)");
  });

  it("entry with no AST match (stale offset): silently skipped", () => {
    // Entry pos doesn't match any param in the AST. CST applier just
    // doesn't see it, no insertion happens. The offset-based applier
    // would have hit positionLooksLikeInsertionSite — which would also
    // have skipped it — so behaviour matches.
    const source = "function foo(a) {}";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 99, [["string"]]), // pos out of range
    ];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(source);
  });

  it("returnType entry routed through CST path matches offset-based applier", () => {
    const source = "function foo() { return 5; }";
    // pos right after `)` of `function foo()` — `(` at 12, `)` at 13, retPos=14
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["number"]], { returnType: true })];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe("function foo(): number { return 5; }");
  });

  it("returnType idempotency: AST-native skip when function already has a return type", () => {
    // Function already declares `: number`. CST path's returnTypeSites
    // sees `node.type !== undefined` and skips — without the
    // offset-based path's `isAlreadyApplied` source-string check.
    const source = "function foo(): number { return 5; }";
    const pos = source.indexOf(")") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { returnType: true })];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(source);
  });

  it("async returnType: Promise<...> wrapping happens in shared computeAnnotationTypeString", () => {
    const source = "async function foo() { return 5; }";
    const pos = source.indexOf(")") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["number"]], { returnType: true, async: true }),
    ];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(applyTypesToFileCst(source, typeInfo, {})).toContain("(): Promise<number>");
  });

  it("param + returnType on same function (both CST): parity with offset-based output", () => {
    const source = "function foo(a) { return a; }";
    const aPos = source.indexOf("a)") + 1;
    const retPos = source.indexOf(")") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", aPos, [["string"]]),
      entry("test.ts", retPos, [["string"]], { returnType: true }),
    ];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(
      "function foo(a: string): string { return a; }",
    );
  });

  it("generator function return type NOT indexed (matches transformer's skip)", () => {
    // The transformer doesn't instrument generator return types, so a
    // typeInfo entry with returnType opt at a generator's pos shouldn't
    // come from a real run. Defensive: if one does arrive, the CST path
    // doesn't index generators in returnTypeSites and the entry falls
    // through to passThrough.
    const source = "function* gen(a) { yield a; }";
    const aPos = source.indexOf("a)") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", aPos, [["number"]])];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("gen(a: number)");
  });

  it("empty typeInfo returns source unchanged", () => {
    const source = "function foo(a) {}";
    expect(applyTypesToFileCst(source, [], {})).toBe(source);
  });

  it("filtered observations (all undefined for optional param) skip cleanly", () => {
    const source = "function foo(a?) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 15, [["undefined"]])];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("function foo(a?) {}");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });
});

describe("applyTypesToFileCst — varDecl + class-field annotations via AST lookup", () => {
  // varDecl + PropertyDeclaration entries indexed by name.end.
  // AST-native idempotency (skip when node.type set), function-RHS
  // guard (skip when RHS is a function expression), and
  // skipInferableVarDecls (skip when TS would already infer the same
  // type) are all expressed against the AST.

  it("annotates `let x = 5` the same as the offset-based applier", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("let x: number = 5;");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it('annotates `const name = "hi"` the same as the offset-based applier', () => {
    const source = 'const name = "hi";';
    const pos = source.indexOf("name") + 4;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["string"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe('const name: string = "hi";');
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("annotates a class field initializer the same as the offset-based applier", () => {
    const source = "class C { value = 42; }";
    const pos = source.indexOf("value") + 5;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("class C { value: number = 42; }");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("idempotency: re-apply on already-typed varDecl is a no-op (AST-native)", () => {
    // The CST path doesn't even index already-typed varDecls in the
    // skip set — varDeclSites HAS them but with `hasType: true`, so the
    // entry is dropped at routing. No source-string `:` heuristic.
    const source = "let x: number = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(source);
  });

  it("idempotency: re-apply on already-typed class field is a no-op", () => {
    const source = "class C { value: bigint = 42n; }";
    const pos = source.indexOf("value") + 5;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { varDecl: true })];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(source);
  });

  it("skips outer annotation when varDecl RHS is a function expression", () => {
    // `const fn = (x) => x` — the outer would be `(arg: unknown) => unknown`,
    // contravariantly incompatible with whatever inner observations
    // produce. CST routes the entry to a site whose rhsIsFunction=true
    // and drops it; no insertion in the AST path.
    const source = "const fn = (x) => x + 1;";
    const fnPos = source.indexOf("fn") + 2;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", fnPos, [["(x: unknown) => unknown"]], { varDecl: true }),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(source); // unchanged — outer skipped
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("skips outer annotation when RHS is a function expression (function keyword)", () => {
    const source = "const fn = function (n) { return n; };";
    const fnPos = source.indexOf("fn") + 2;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", fnPos, [["(n: unknown) => unknown"]], { varDecl: true }),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(source);
  });

  it("function-RHS guard does NOT fire for non-function RHS", () => {
    const source = "const count = 42;";
    const pos = source.indexOf("count") + 5;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("const count: number = 42;");
  });

  it("skipInferableVarDecls (off): annotation lands as usual", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("let x: number = 5;");
  });

  it("skipInferableVarDecls (on): `let x = 5` skips redundant `: number`", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
    });
    expect(cst).toBe(source);
    expect(cst).toBe(
      applyTypesToFile(source, typeInfo, {
        infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
      }),
    );
  });

  it("skipInferableVarDecls (on): `const x = 5` SKIPS annotation", () => {
    // Without skipInferableVarDecls, ts-capture would widen TS's
    // literal `5` to `: number`. With the flag on, TS's literal
    // narrowing wins.
    const source = "const x = 5;";
    const pos = source.indexOf("x") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
    });
    expect(cst).toBe(source);
  });

  it("skipInferableVarDecls (on): `readonly` class field with primitive SKIPS annotation", () => {
    const source = "class C { readonly x = 5; }";
    const pos = source.indexOf("x = 5") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
    });
    expect(cst).toBe(source);
  });

  it("skipInferableVarDecls (on): `as const` on object literal SKIPS annotation", () => {
    const source = "const X = { a: 1 } as const;";
    const pos = source.indexOf("X") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["{ a: number }"]], { varDecl: true }),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipInferableVarDecls: true },
    });
    expect(cst).toBe(source);
  });

  it("varDecl + param + returnType in one file: all three through CST, parity with offset-based", () => {
    // The big mixed test: every entry kind we currently route through
    // CST coexisting in one file. Output must match the offset-based
    // applier byte-for-byte.
    const source = "let n = 0;\nfunction foo(a) { return a; }";
    const nPos = source.indexOf("n ") + 1;
    const aPos = source.indexOf("a)") + 1;
    const retPos = source.indexOf(")") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", nPos, [["number"]], { varDecl: true }),
      entry("test.ts", aPos, [["string"]]),
      entry("test.ts", retPos, [["string"]], { returnType: true }),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("let n: number = 0");
    expect(cst).toContain("function foo(a: string): string");
  });
});

describe("applyTypesToFileCst — paren-less arrow params + thisType (final routing items)", () => {
  // The remaining offset-based-only cases: paren-less single-param
  // arrows (`x => body`) need both an opening `(` and a `: T)` insert,
  // and `this` parameters need `this: T` (or `this: T, ` if other
  // params follow). Both are now indexed in the AST pass.

  it("paren-less arrow param: `x => x + 1` wraps with parens via CST", () => {
    const source = "const inc = x => x + 1;";
    // pos in typeInfo for paren-less arrow param: name.end = position after `x`
    const pos = source.indexOf("x ") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["number"]], { arrow: true, parens: [pos - 1, pos] }),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("(x: number) =>");
  });

  it("paren-less arrow + return type: CST applies BOTH (offset-based skips return due to its position-validity guard)", () => {
    // CST is strictly better here: both inserts target the SAME offset
    // (paren-less arrow has retPos === parameters.end === paramPos),
    // and the CST priority ordering (-1 for return) lets the offset-
    // collision resolve cleanly to `(x: T1): T2 => body`. The offset-
    // based path's positionLooksLikeInsertionSite requires `before
    // === ")"` for returnType entries; paren-less arrows have `x ` at
    // that position, so the offset path skips the return annotation
    // and only emits `(x: number) => x + 1;`. We assert the CST
    // behaviour explicitly here.
    const source = "const inc = x => x + 1;";
    const paramPos = source.indexOf("x ") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", paramPos, [["number"]], { arrow: true, parens: [paramPos - 1, paramPos] }),
      entry("test.ts", paramPos, [["number"]], { returnType: true }),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toContain("(x: number): number =>");
    // Note: NOT asserting parity with applyTypesToFile here — this is
    // a known case where CST is strictly more capable.
  });

  it("regular paren'd arrow param NOT wrapped: parensOpenPos undefined for parens-on-source case", () => {
    const source = "const inc = (x) => x + 1;";
    const pos = source.indexOf("x)") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]])];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    expect(cst).toContain("(x: number) =>");
  });

  it("thisType: `function greet() { return this.text; }` gets `this: Date`", () => {
    const source = "function greet() { return this.text; }";
    // parameters.pos is right after `(` — offset 15
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 15, [["Date"]], { thisType: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("function greet(this: Date) { return this.text; }");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("thisType with other params: AST reads `, ` need from parameters.length (no thisNeedsComma flag required)", () => {
    // The transformer normally sets `thisNeedsComma: true` when the
    // function already has params; the offset-based path uses that
    // flag. The CST path reads `node.parameters.length > 0` directly
    // from the AST and adds the separator without needing the flag.
    // To test parity, we include `thisNeedsComma` in the typeInfo (as
    // the real transformer would) — both paths then produce the same
    // output.
    const source = "function greet(name) { return this.text + name; }";
    // parameters.pos = 15 (after `(`); name's name.end = 19
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 15, [["Date"]], { thisType: true, thisNeedsComma: true }),
      entry("test.ts", 19, [["string"]]),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("function greet(this: Date, name: string) { return this.text + name; }");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
  });

  it("thisType with other params: CST handles missing `thisNeedsComma` flag too (AST-derived)", () => {
    // Even if the typeInfo entry doesn't carry `thisNeedsComma`
    // (legacy dump file, third-party producer), the CST path's
    // AST-derived hasOtherParams check still emits the separator
    // correctly. The offset-based path would produce `this: Datename`
    // (broken) in this case — CST is more robust.
    const source = "function greet(name) { return this.text + name; }";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 15, [["Date"]], { thisType: true }),
      entry("test.ts", 19, [["string"]]),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe("function greet(this: Date, name: string) { return this.text + name; }");
  });

  it("thisType: pos with no matching function falls through to passThrough", () => {
    // typeInfo entry at a pos that doesn't correspond to any
    // function's parameters.pos. AST-side index has nothing; entry
    // routes to passThrough → offset-based applier handles (or
    // skips via positionLooksLikeInsertionSite).
    const source = "function greet() { return this.text; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 999, [["Date"]], { thisType: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {});
    expect(cst).toBe(applyTypesToFile(source, typeInfo, {}));
    // Both produce the unchanged source (offset doesn't validate).
    expect(cst).toBe(source);
  });
});

describe("applyTypesToFileCst — TypeChecker verify integration", () => {
  // Mirrors apply-types-verify.spec.ts: drive the CST applier with a
  // real LanguageService-backed verify context built from a tiny
  // on-disk project. Accept / reject / mixed-batch coverage to prove
  // the slice-2b pattern landed correctly inside applyTypesToFileCst.

  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-cst-verify-"));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  function makeProject(files: Record<string, string>): {
    dir: string;
    target: string;
    targetSource: string;
    fileNames: string[];
    compilerOptions: ts.CompilerOptions;
  } {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "p-"));
    const tsconfig = {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "Bundler",
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["**/*.ts"],
    };
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, dir);
    const fileNames = parsed.fileNames;
    const target = fileNames.find((f) => f.endsWith("target.ts"));
    if (!target) {
      throw new Error("test must include a `target.ts` file");
    }
    const targetSource = fs.readFileSync(target, "utf-8");
    return { dir, target, targetSource, fileNames, compilerOptions: parsed.options };
  }

  it("accepts a sound annotation through the CST path", () => {
    const proj = makeProject({ "target.ts": "function id(a) { return a; }\n" });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    // pos = name.end of `a` (1-based after `function id(`).
    const aEnd = proj.targetSource.indexOf("(a)") + 2;
    const typeInfo: CollectedTypeInfo = [entry(proj.target, aEnd, [["unknown"]])];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    expect(result).toBe("function id(a: unknown) { return a; }\n");
  });

  it("rejects an annotation that introduces a type error (varDecl narrowed below value)", () => {
    // `const x = 1` cannot be annotated `: string` — TS rejects.
    const proj = makeProject({ "target.ts": "const x = 1;\n" });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    const xEnd = proj.targetSource.indexOf("x") + 1;
    const typeInfo: CollectedTypeInfo = [entry(proj.target, xEnd, [["string"]], { varDecl: true })];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // Annotation rejected → source unchanged.
    expect(result).toBe(proj.targetSource);
  });

  it("mixed batch: accepted candidates land, rejected ones drop", () => {
    // Two annotations in one file: `a: number` is legal, `b: string`
    // is illegal (b's initializer is 2). Verify must accept a, drop b.
    const proj = makeProject({
      "target.ts": "const a = 1;\nconst b = 2;\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    const aEnd = proj.targetSource.indexOf("a") + 1;
    const bEnd = proj.targetSource.indexOf("b") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, aEnd, [["number"]], { varDecl: true }),
      entry(proj.target, bEnd, [["string"]], { varDecl: true }),
    ];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    expect(result).toContain("const a: number = 1");
    expect(result).toContain("const b = 2");
    expect(result).not.toContain("const b: string");
  });

  it("oracle catches Promise<unknown> returnType-vs-parent-interface narrowing via transitive importer scan", () => {
    // Real-world: react-admin's CrmDataProvider = typeof dataProvider.
    // ActivityLog.tsx imports the type through a re-export barrel
    // (providers/types.ts → dataProvider.ts). Annotating
    // `: Promise<unknown>` on dataProvider's checkAuth slot widens
    // its inferred type, breaking consumer.ts's `const out: Activity[]
    // = await dp.checkAuth();`. The direct-importer scan missed
    // this (consumer is 2 hops away); the transitive scan picks
    // it up. The `isUselessPromise` heuristic was removed
    // because the oracle now covers it.
    const proj = makeProject({
      "target.ts":
        "export const provider = { fetch: () => Promise.resolve(42) };\n" +
        "export type Provider = typeof provider;\n",
      "index.ts": "export * from './target';\n",
      "consumer.ts":
        "import { Provider } from './index';\n" +
        "declare const p: Provider;\n" +
        "async function use() { const n: number = await p.fetch(); return n; }\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    // Insert `: Promise<unknown>` as the return type of `fetch`'s arrow.
    // pos = the `)` of `()` in `fetch: () =>`.
    const fetchIdx = proj.targetSource.indexOf("fetch: ()");
    const paramsClose = proj.targetSource.indexOf(")", fetchIdx) + 1;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, paramsClose, [["Promise<unknown>"]], {
        returnType: true,
        async: true,
        fnRetPos: paramsClose,
      }),
    ];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // Oracle rejects via the transitive scan: consumer.ts's
    // `const n: number = await p.fetch()` would fail if fetch is
    // typed `Promise<unknown>`. Source unchanged.
    expect(result).toBe(proj.targetSource);
    expect(result).not.toContain("Promise<unknown>");
  });

  it("oracle catches the emit-quality regression where a structural object of useless-arrow methods narrows binding", () => {
    // Previously: `emittedHasUselessArrowMethod` skipped any
    // structural-object annotation containing `() => unknown`
    // method signatures, because burning that onto a varDecl
    // shadows the consumer's declared interface (DataProvider /
    // AuthProvider). With the transitive scan the oracle
    // catches the resulting consumer-side type errors directly.
    const proj = makeProject({
      "target.ts":
        "interface Provider { create: () => string; getList: () => number[]; }\n" +
        "declare function makeProvider(): Provider;\n" +
        "export const provider = makeProvider();\n",
      "index.ts": "export * from './target';\n",
      "consumer.ts":
        "import { provider } from './index';\n" + "const result: number[] = provider.getList();\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    // Probe: annotate `provider` with a structural object that drops
    // `getList`. Consumer breaks because `provider.getList` no longer
    // exists on the narrower type.
    const providerEnd = proj.targetSource.indexOf("provider = ") + "provider".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, providerEnd, [["{ create: (resource: unknown) => unknown }"]], {
        varDecl: true,
      }),
    ];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // Oracle rejects via transitive scan — consumer.ts's
    // `provider.getList()` call would fail on the narrower type.
    expect(result).toBe(proj.targetSource);
    expect(result).not.toContain("(resource: unknown)");
  });

  it("oracle catches returnType narrowing below a `return undefined` branch", () => {
    // The `narrowingReturnTypeFns` heuristic (removed) used to
    // scan function bodies for `return undefined` / bare `return` /
    // `return null` branches and skip the returnType annotation for
    // those positions. The TS2322 error fires AT the function's own
    // `return undefined` line — same file as the annotation — so the
    // oracle catches it directly without the transitive scan.
    const proj = makeProject({
      "target.ts":
        "export function transformFilter(f: number | null) {\n" +
        "    if (f === null) return undefined;\n" +
        "    return { id: f };\n" +
        "}\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    // Probe: insert `: { id: number }` returnType — the narrow shape
    // ts-capture would observe from a successful call. Function's own
    // `return undefined;` then fails TS2322.
    const paramsClose = proj.targetSource.indexOf(")") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, paramsClose, [["{ id: number }"]], {
        returnType: true,
        fnRetPos: paramsClose,
      }),
    ];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // Oracle rejects: source unchanged.
    expect(result).toBe(proj.targetSource);
    expect(result).not.toContain(": { id: number }");
  });

  it("oracle catches a param annotation broader than its satisfies clause", () => {
    // The `satisfiesContextPositions` heuristic (removed)
    // skipped any annotation on functions nested inside a satisfies
    // expression. The motivation: ResourceCallbacks<T>['beforeUpdate']
    // declares `(p: UpdateParams<T>) => …` but ts-capture observed
    // one specific call where the runtime value also carried extra
    // fields, so apply emitted a BROADER param shape that broke the
    // satisfies clause via function param contravariance.
    const proj = makeProject({
      "target.ts":
        "const cbs = [{\n" +
        "    handle: (params) => params.id,\n" +
        "} satisfies { handle: (p: { id: number }) => unknown }];\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    // Probe: insert `: { id: number; tags: number[] }` — broader
    // than the satisfies clause's `{ id: number }`. Function param
    // contravariance: satisfies side's `{ id: number }` not
    // assignable to annotation's `{ id: number; tags: number[] }`.
    // satisfies expression fails type-check at the same file.
    const paramEnd = proj.targetSource.indexOf("params)") + "params".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, paramEnd, [["{ id: number; tags: number[] }"]], { arrow: true }),
    ];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // Oracle rejects: source unchanged.
    expect(result).toBe(proj.targetSource);
  });

  it("oracle catches a spread RHS narrowing below same-file property access", () => {
    // Previously: `objectLiteralHasMethodProperty` detected spread
    // assignments (`{ ...data }`) and skipped the outer annotation
    // because the captured shape misses fields that arrive via the
    // spread. The downstream TS2339 fires AT a property-access line
    // in the same file — oracle catches it directly.
    const proj = makeProject({
      "target.ts":
        "declare const data: { tags: number[]; company_id: number };\n" +
        "function f() {\n" +
        "    const newData = { ...data };\n" +
        "    return newData.company_id;\n" +
        "}\n" +
        "f();\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    // Probe: annotate `newData` as `: { tags: number[] }`. The spread
    // brings in `company_id` but the narrow annotation drops it —
    // the subsequent `newData.company_id` access fails TS2339.
    const newDataEnd = proj.targetSource.indexOf("newData") + "newData".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, newDataEnd, [["{ tags: number[] }"]], { varDecl: true }),
    ];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // Oracle rejects: source unchanged.
    expect(result).toBe(proj.targetSource);
  });

  it("oracle catches an object literal of useless-arrow methods vs parent interface", () => {
    // Previously: `objectLiteralHasMethodProperty` detected method
    // properties (both arrow-as-PropertyAssignment and shorthand
    // MethodDeclaration) and skipped the outer annotation. The real
    // regression — a structural `(arg: unknown) => unknown` shape
    // breaks contextual typing against a parent interface like
    // `DataProvider` — surfaces at the consumer, caught by the
    // transitive scan.
    const proj = makeProject({
      "target.ts":
        "interface Provider { create: (resource: string) => Promise<number>; }\n" +
        "export const provider = { create: (resource) => Promise.resolve(1) };\n",
      "index.ts": "export * from './target';\n",
      "consumer.ts":
        "import { provider } from './index';\n" +
        "const dp: Provider = provider;\n" +
        "// typecheck-only: provider must structurally satisfy Provider.\n",
    });
    // Add Provider to the consumer file too via re-import so the test
    // is self-consistent.
    const consumerPath = proj.fileNames.find((f) => f.endsWith("consumer.ts"))!;
    const consumerSource =
      "import { provider } from './index';\n" +
      "interface Provider { create: (resource: string) => Promise<number>; }\n" +
      "const dp: Provider = provider;\n" +
      "void dp;\n";
    fs.writeFileSync(consumerPath, consumerSource);
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    // Probe: annotate `provider` with the literal shape having
    // `(r: unknown) => unknown` — too broad on params (function
    // param contravariance: `string` not assignable to `unknown`'s
    // contravariant input position when we look at the OTHER
    // direction) and too narrow on return (unknown vs Promise<number>).
    const providerEnd = proj.targetSource.indexOf("provider = ") + "provider".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, providerEnd, [["{ create: (resource: unknown) => unknown }"]], {
        varDecl: true,
      }),
    ];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // Oracle rejects via transitive scan — consumer.ts's
    // `const dp: Provider = provider` would fail.
    expect(result).toBe(proj.targetSource);
  });

  it("steady-state re-apply produces zero verify probes (AST idempotency)", () => {
    // Verifies the steady-state acceptance: a second apply on
    // already-annotated source must NOT exercise the verify path at
    // all. The CST applier's AST-native idempotency check
    // (`node.type !== undefined`) skips already-typed sites BEFORE
    // they enter `annotationCandidates`, so `filterAcceptedReplacements`
    // sees an empty array and never calls `wouldIntroduceErrors`.
    //
    // Instrument by spying on the verify context's
    // `filterAcceptedReplacements` indirectly: count probes via a
    // wrapped service. Simplest signal: re-apply on annotated source
    // must return the source unchanged AND `currentSource` must equal
    // the input (no `advanceCurrentSource` either — pass-through is
    // also empty when nothing is left to apply).
    const proj = makeProject({
      "target.ts": "export function id(a: unknown): unknown { return a; }\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    // pos = `a`'s name.end (already typed in source).
    const aEnd = proj.targetSource.indexOf("a:") + 1;
    const paramsClose = proj.targetSource.indexOf(")") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, aEnd, [["unknown"]]),
      entry(proj.target, paramsClose, [["unknown"]], { returnType: true }),
    ];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // Both entries hit existing annotations → AST idempotency skips
    // both before they reach the verify batch. No probes, no source
    // mutation.
    expect(result).toBe(proj.targetSource);
    expect(verifyCtx.currentSource).toBe(proj.targetSource);
  });

  it("does not mutate verify context when all candidates are rejected", () => {
    const proj = makeProject({ "target.ts": "const x = 1;\n" });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
    const xEnd = proj.targetSource.indexOf("x") + 1;
    const typeInfo: CollectedTypeInfo = [entry(proj.target, xEnd, [["string"]], { varDecl: true })];
    applyTypesToFileCst(proj.targetSource, typeInfo, { verify: verifyCtx });
    // currentSource untouched (advanceCurrentSource only fires when
    // pass-through is non-empty, and even then only if afterCst !==
    // source — which it doesn't when all candidates were rejected).
    expect(verifyCtx.currentSource).toBe(proj.targetSource);
  });
});

describe("applyTypesToFileCst — infer.ignoreExistingTypes", () => {
  // Divergence-measurement mode: bypass the AST-native idempotency checks
  // (`!node.type` filter on params, `hasType` skip on varDecls,
  // `hasReturnType` skip on return types). The new annotation is emitted
  // even at already-typed positions; output is intentionally broken TS
  // but the emitted annotations are grep-able.

  it("default behaviour: typed param is NOT indexed (existing CST contract)", () => {
    // Sanity for parity with the legacy idempotency-test in apply-types.spec.ts.
    const source = "function foo(a: string) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["number"]])];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(source);
  });

  it("flag on: typed param IS re-annotated despite existing annotation", () => {
    const source = "function foo(a: string) {}";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 14, [["number"]])];
    const result = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, ignoreExistingTypes: true },
    });
    expect(result).toContain(": number");
    expect(result).not.toBe(source);
  });

  it("flag on: typed varDecl IS re-annotated", () => {
    const source = "const x: number = 1;";
    // pos = end of "x" (after the identifier name)
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 7, [["string"]], { varDecl: true })];
    const result = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, ignoreExistingTypes: true },
    });
    expect(result).toContain(": string");
    expect(result).not.toBe(source);
  });
});
