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

// Several fixtures below declare `let x = 5` / `const name = "hi"`, which
// `skipRedundantAnnotations` (on by default) correctly leaves alone — annotating
// them would widen TypeScript's own inference. These tests are about applier
// parity and offset handling, not about the skip, so they pin it off.
const KEEP_INFERABLE = { infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: false } };

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

  // Regression: nestjs/nest, packages/core/router/router-response-controller.ts.
  // A promise executor parameter was observed twice at one offset — once as
  // the arrow parameter, once as the return of calling it (`paramReturn`).
  // Routing keyed on the raw opts object kept them as separate sites and both
  // were emitted, producing `(resolve: undefined: Function)`, which does not
  // parse and took 21 spec files down with it.
  it("annotates a param from its own observation, not from what calling it returned", () => {
    const source = "const run = (resolve) => { resolve(); };";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", 20, [["Function"]], { arrow: true, fnRetPos: 21 }),
      entry("test.ts", 20, [["undefined"]], {
        paramReturn: true,
        paramReturnMember: "resolve",
      }),
    ];
    // `resolve` is a `Function`; the `undefined` is what calling it produced.
    // Keying dedup by site kind alone merged the two into `Function|undefined`
    // — parseable, and wrong. `crossReferenceObservations` drops paramReturn
    // records before apply ever sees them; this covers the direct-API route.
    const expected = "const run = (resolve: Function) => { resolve(); };";
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(expected);
    expect(applyTypesToFile(source, typeInfo, {})).toBe(expected);
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
    const cst = applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE);
    expect(cst).toBe(applyTypesToFile(source, typeInfo, KEEP_INFERABLE));
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
    const cst = applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE);
    expect(cst).toBe(applyTypesToFile(source, typeInfo, KEEP_INFERABLE));
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
    const cst = applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE);
    expect(cst).toBe(applyTypesToFile(source, typeInfo, KEEP_INFERABLE));
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
  // skipRedundantAnnotations (skip when TS would already infer the same
  // type) are all expressed against the AST.

  it("annotates `let x = 5` the same as the offset-based applier", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE);
    expect(cst).toBe("let x: number = 5;");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, KEEP_INFERABLE));
  });

  it('annotates `const name = "hi"` the same as the offset-based applier', () => {
    const source = 'const name = "hi";';
    const pos = source.indexOf("name") + 4;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["string"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE);
    expect(cst).toBe('const name: string = "hi";');
    expect(cst).toBe(applyTypesToFile(source, typeInfo, KEEP_INFERABLE));
  });

  it("annotates a class field initializer the same as the offset-based applier", () => {
    const source = "class C { value = 42; }";
    const pos = source.indexOf("value") + 5;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE);
    expect(cst).toBe("class C { value: number = 42; }");
    expect(cst).toBe(applyTypesToFile(source, typeInfo, KEEP_INFERABLE));
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
    const cst = applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE);
    expect(cst).toBe("const count: number = 42;");
  });

  it("skipRedundantAnnotations (off): annotation lands as usual", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: false },
    });
    expect(cst).toBe("let x: number = 5;");
  });

  // Defaults matter here: annotating `const X = 'lit'` with `: string` does not
  // add information, it destroys it — TypeScript already infers the literal
  // type `'lit'`, and the annotation widens it. A run on nestjs/nest produced
  // 105 such widening annotations, ~8% of the whole diff.
  it("skipRedundantAnnotations is on by default: a const literal keeps its narrow type", () => {
    const source = "const FLAG = 'on';";
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", source.indexOf("FLAG") + 4, [["string"]], { varDecl: true }),
    ];
    expect(applyTypesToFileCst(source, typeInfo, {})).toBe(source);
    expect(applyTypesToFile(source, typeInfo, {})).toBe(source);
  });

  it("skipRedundantAnnotations (on): `let x = 5` skips redundant `: number`", () => {
    const source = "let x = 5;";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", 5, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: true },
    });
    expect(cst).toBe(source);
    expect(cst).toBe(
      applyTypesToFile(source, typeInfo, {
        infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: true },
      }),
    );
  });

  it("skipRedundantAnnotations (on): `const x = 5` SKIPS annotation", () => {
    // Without skipRedundantAnnotations, ts-capture would widen TS's
    // literal `5` to `: number`. With the flag on, TS's literal
    // narrowing wins.
    const source = "const x = 5;";
    const pos = source.indexOf("x") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: true },
    });
    expect(cst).toBe(source);
  });

  it("skipRedundantAnnotations (on): `readonly` class field with primitive SKIPS annotation", () => {
    const source = "class C { readonly x = 5; }";
    const pos = source.indexOf("x = 5") + 1;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["number"]], { varDecl: true })];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: true },
    });
    expect(cst).toBe(source);
  });

  it("skipRedundantAnnotations (on): `as const` on object literal SKIPS annotation", () => {
    const source = "const X = { a: 1 } as const;";
    const pos = source.indexOf("X") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["{ a: number }"]], { varDecl: true }),
    ];
    const cst = applyTypesToFileCst(source, typeInfo, {
      infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: true },
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
    const cst = applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE);
    expect(cst).toBe(applyTypesToFile(source, typeInfo, KEEP_INFERABLE));
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

  // --- checker-backed redundancy suppression -------------------------------
  //
  // The predicate itself is covered in redundant-annotation.spec.ts. These
  // prove the wiring: with a real Program in hand the applier must drop
  // annotations TypeScript already implies, at all three site kinds, and must
  // keep the ones that carry information the checker does not have.

  function applyWithProgram(
    files: Record<string, string>,
    typeInfoFor: (src: string, target: string) => CollectedTypeInfo,
  ): string {
    const proj = makeProject(files);
    const program = ts.createProgram(proj.fileNames, proj.compilerOptions);
    return applyTypesToFileCst(
      proj.targetSource,
      typeInfoFor(proj.targetSource, proj.target),
      { filename: proj.target },
      program,
    );
  }

  // Deliberately NOT a literal initializer: `inferTypeFromInitializer` already
  // suppresses those syntactically, so a literal fixture would pass with the
  // checker disabled and prove nothing. A call expression is invisible to the
  // syntactic path — only the checker knows `g()` returns a string.
  it("drops a varDecl annotation the checker already infers from a call", () => {
    const result = applyWithProgram(
      {
        "target.ts": 'function g(): string {\n  return "x";\n}\nexport const v = g();\n',
      },
      (src, target) => [entry(target, src.indexOf("const v") + 7, [["string"]], { varDecl: true })],
    );
    expect(result).not.toContain("v: string");
    expect(result).toBe('function g(): string {\n  return "x";\n}\nexport const v = g();\n');
  });

  it("drops a contextually typed Array.prototype callback param", () => {
    const result = applyWithProgram(
      {
        "target.ts": "const xs: string[] = [];\nexport const ys = xs.map(v => v.length);\n",
      },
      (src, target) => [entry(target, src.indexOf("(v =>") + 2, [["string"]], { arrow: true })],
    );
    expect(result).not.toContain("v: string");
    // ...and no orphaned parens either: wrapping `v` without annotating it is
    // pure diff noise.
    expect(result).toBe("const xs: string[] = [];\nexport const ys = xs.map(v => v.length);\n");
  });

  it("drops a return-type annotation the body already implies", () => {
    const result = applyWithProgram(
      { "target.ts": 'export function greet() {\n  return "hi";\n}\n' },
      (src, target) => [entry(target, src.indexOf("()") + 2, [["string"]], { returnType: true })],
    );
    expect(result).not.toContain("): string");
  });

  // The wrap for a paren-less arrow is emitted separately from the annotation
  // so it survives *one* entry being skipped while a sibling still lands. When
  // nothing lands at that position the parens are pure noise — 175 such lines
  // in a nest run, 36% of the whole diff.
  it("does not wrap a paren-less arrow param when the annotation is suppressed", () => {
    const result = applyWithProgram(
      { "target.ts": "const xs: { a: number }[] = [];\nexport const ys = xs.map(v => v.a);\n" },
      (src, target) => [
        entry(target, src.indexOf("(v =>") + 2, [["{ a: number }"]], { arrow: true }),
      ],
    );
    expect(result).toBe("const xs: { a: number }[] = [];\nexport const ys = xs.map(v => v.a);\n");
  });

  // The guard on the guard: a paren-less arrow whose *param* annotation is
  // dropped but whose *returnType* annotation lands still needs the parens —
  // `v: number => body` is a syntax error. Deferring the wrap must not lose
  // this case.
  it("still wraps a paren-less arrow when a sibling annotation lands", () => {
    const source = "const ys = xs.map(v => v.length);";
    const paramPos = source.indexOf("(v =>") + 2;
    const typeInfo: CollectedTypeInfo = [
      // Rejected: `Unknowable` is not a type name in scope.
      entry("test.ts", paramPos, [["Unknowable"]], { arrow: true }),
      // Accepted, and lands at the same offset.
      entry("test.ts", paramPos, [["number"]], { returnType: true }),
    ];
    const result = applyTypesToFileCst(source, typeInfo, {});
    expect(result).toContain("(v): number =>");
    const parsed = ts.createSourceFile("o.ts", result, ts.ScriptTarget.Latest, true);
    const diags = (parsed as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics;
    expect(diags ?? []).toHaveLength(0);
  });

  it("still annotates a parameter the checker only knows as any", () => {
    const result = applyWithProgram(
      { "target.ts": "export function use(p) {\n  return p;\n}\n" },
      (src, target) => [entry(target, src.indexOf("(p)") + 2, [["string"]])],
    );
    expect(result).toContain("p: string");
  });

  it("still annotates when the run observed more than the checker infers", () => {
    const result = applyWithProgram(
      { "target.ts": "export function use(p) {\n  return p;\n}\n" },
      (src, target) => [entry(target, src.indexOf("(p)") + 2, [["string"], ["number"]])],
    );
    expect(result).toMatch(/p: (number\|string|string\|number)/);
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
    // `string`, not `unknown`: the subject is the CST verify path, and a
    // vacuous type is dropped before verify ever sees it.
    const typeInfo: CollectedTypeInfo = [entry(proj.target, aEnd, [["string"]])];
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, {
      verify: verifyCtx,
    });
    expect(result).toBe("function id(a: string) { return a; }\n");
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
    const result = applyTypesToFileCst(proj.targetSource, typeInfo, {
      ...KEEP_INFERABLE,
      verify: verifyCtx,
    });
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

  // `skipRedundantAnnotations` reads as a redundancy switch, and its
  // documentation says nothing more. It used to gate the whole checker, so
  // turning it off also turned off every guard against a destructive write —
  // including this one, which refuses a type *narrower* than the inferred one.
  // That direction does not remove an error, it introduces one.
  it("refuses a narrowing annotation even with the redundancy flag off", () => {
    const proj = makeProject({
      "target.ts":
        "declare const k: string | symbol;\n" +
        "export function f() {\n" +
        "  const key = k;\n" +
        "  return key;\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const keyEnd = proj.targetSource.indexOf("const key") + "const key".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, keyEnd, [["string"]], { varDecl: true }),
    ];
    const opts = {
      filename: proj.target,
      infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: false },
    };
    expect(applyTypesToFileCst(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
    expect(applyTypesToFile(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
  });

  // A line start inside a multi-line template is inside the *string*. Writing
  // a note there makes it text, and its backticks close the template early.
  // Found by looking at applied output, not by a test — nest has no
  // annotation site inside a template literal.
  it("writes no note where the line start is inside a template literal", () => {
    const src = "const items = [{ id: 1 }];\nconst s = `\n  ${items.map(x => x.id)}\n`;\n";
    const xEnd = src.indexOf("x =>") + 1;
    const typeInfo: CollectedTypeInfo = [entry("t.ts", xEnd, [["number"]])];
    const out = applyTypesToFileCst(src, typeInfo, {
      infer: { ...INFER_DEFAULTS, outputMode: "both" },
      filename: "t.ts",
    });
    expect(out).not.toContain("@ts-capture");
    // The annotation itself is unaffected — it goes inside the interpolation,
    // which is code.
    expect(out).toContain("(x: number)");
  });

  // The dialect matters: parsing a `.ts` file as TSX reads `<` as a JSX tag,
  // and the misparse invents JsxText over ordinary code. That refused a real
  // note on nest — `const currentRoutingKey = routingKeySegments[i];`, which
  // is not inside anything.
  it("writes a note in a .ts file that uses angle brackets", () => {
    const src = "const parts = collect<string>(input);\nconst first = parts[0];\n";
    const firstEnd = src.indexOf("const first") + "const first".length;
    const typeInfo: CollectedTypeInfo = [entry("t.ts", firstEnd, [["string"]], { varDecl: true })];
    const out = applyTypesToFileCst(src, typeInfo, {
      infer: { ...INFER_DEFAULTS, outputMode: "comments" },
      filename: "t.ts",
    });
    expect(out).toContain("// @ts-capture[proposal]: `first` would be `string`");
  });

  // The checker's view is held in one variable shared by every branch, and the
  // `this` branch never sets it — so its preview reported whatever the previous
  // entry had asked about. Here that is `v`, a binding in another function two
  // lines up. A note that names the wrong position is worse than no note.
  it("does not let a preview claim a type from another site", () => {
    const proj = makeProject({
      "target.ts":
        "declare const n: number;\n" +
        "export function g() {\n" +
        "  const v = n;\n" +
        "  return v;\n" +
        "}\n" +
        "export function needsThis(x) {\n" +
        "  return x;\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const vEnd = proj.targetSource.indexOf("const v") + "const v".length;
    const parensPos = proj.targetSource.indexOf("needsThis(") + "needsThis(".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, vEnd, [["number"]], { varDecl: true }),
      entry(proj.target, parensPos, [["string"]], { thisType: true }),
    ];
    const out = applyTypesToFileCst(
      proj.targetSource,
      typeInfo,
      { filename: proj.target, infer: { ...INFER_DEFAULTS, outputMode: "comments" } },
      program,
    );
    expect(out).toContain("`this` would be `string`");
    expect(out).not.toContain("TypeScript infers `number`");
  });

  // The CST applier hands its pass-through entries to the offset applier along
  // with the source it has already rewritten — notes included. If the second
  // pass stripped as well, it would delete what the first one just wrote.
  // A note cannot be written on a line whose start is inside template text —
  // the comment would become part of the string. The contradiction is still
  // real, so the annotation is still refused: apply reports rather than fixes,
  // and a contradiction it cannot report is not a licence to write.
  it("writes neither note nor annotation when the note cannot be placed", () => {
    const proj = makeProject({
      "target.ts":
        "export function f(): string {\n" +
        "  return 'x';\n" +
        "}\n" +
        "export const t = `\n" +
        "head ${(() => { const p = f(); return p; })()} tail\n" +
        "`;\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const pEnd = proj.targetSource.indexOf("const p") + "const p".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, pEnd, [["string|undefined"]], { varDecl: true }),
    ];
    const opts = { filename: proj.target };
    expect(applyTypesToFileCst(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
    expect(applyTypesToFile(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
  });

  // Regression: the offset applier used `break` where it meant "skip this
  // site", so one unplaceable note abandoned the entry loop and every later
  // annotation in the file was lost silently.
  it("keeps annotating later sites after a note it could not place", () => {
    const proj = makeProject({
      "target.ts":
        "export function f(): string {\n" +
        "  return 'x';\n" +
        "}\n" +
        "export const t = `\n" +
        "head ${(() => { const p = f(); return p; })()} tail\n" +
        "`;\n" +
        "export function later(a) {\n" +
        "  return a;\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const pEnd = proj.targetSource.indexOf("const p") + "const p".length;
    const aPos = proj.targetSource.indexOf("later(a)") + "later(a".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, pEnd, [["string|undefined"]], { varDecl: true }),
      entry(proj.target, aPos, [["number"]]),
    ];
    const opts = { filename: proj.target };
    expect(applyTypesToFile(proj.targetSource, typeInfo, opts, program)).toContain(
      "export function later(a: number) {",
    );
    expect(applyTypesToFileCst(proj.targetSource, typeInfo, opts, program)).toContain(
      "export function later(a: number) {",
    );
  });

  // Both appliers place notes by one rule, and that rule lives in
  // `noteReplacements` — the only place that knows whether a line is crowded
  // and the note therefore goes at the site rather than above it. An early
  // check in one applier answered the leading-line question for notes that
  // never became leading lines, and dropped them.
  it("places the same notes from either applier on a crowded line inside a template", () => {
    const src = "const t = `\nhead ${[1].map((a) => [2].map((b) => a + b))} tail\n`;\n";
    const typeInfo: CollectedTypeInfo = [
      entry("t.ts", src.indexOf("(a)") + 2, [["number"]]),
      entry("t.ts", src.indexOf("(b)") + 2, [["number"]]),
    ];
    const opts = {
      filename: "t.ts",
      infer: { ...INFER_DEFAULTS, outputMode: "comments" as const },
    };
    const count = (out: string) => (out.match(/@ts-capture/g) ?? []).length;
    expect(count(applyTypesToFileCst(src, typeInfo, opts))).toBe(2);
    expect(count(applyTypesToFile(src, typeInfo, opts))).toBe(2);
  });

  // `this` has no single value to write down — the same loss the return-type
  // rule above refuses, arriving through a contextually typed parameter. The
  // offset applier already refused it; the CST applier, which is the default,
  // did not.
  it("never annotates a param the checker infers as `this`", () => {
    const proj = makeProject({
      "target.ts":
        "export class Box {\n" +
        "  each(fn: (self: this) => void) {\n" +
        "    fn(this);\n" +
        "  }\n" +
        "  go() {\n" +
        "    this.each((s) => s.go());\n" +
        "  }\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const sPos = proj.targetSource.indexOf("((s)") + "((s".length;
    const typeInfo: CollectedTypeInfo = [entry(proj.target, sPos, [["Box"]], { arrow: true })];
    const opts = { filename: proj.target };
    expect(applyTypesToFileCst(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
    expect(applyTypesToFile(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
  });

  it("never annotates a return type the checker infers as `this`", () => {
    // A builder that returns `this` keeps working in a subclass. The run only
    // ever sees the concrete instance, so ts-capture writes the class name and
    // every subclass caller gets the base class back. Eight nest methods, all
    // builders, were annotated that way.
    const proj = makeProject({
      "target.ts":
        "export class Builder {\n" +
        "  addValidator() {\n" +
        "    return this;\n" +
        "  }\n" +
        "}\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const paramsClose = proj.targetSource.indexOf("addValidator()") + "addValidator()".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, paramsClose, [["Builder"]], {
        returnType: true,
        fnRetPos: paramsClose,
      }),
    ];
    // The checker index needs `program` + `filename`; without them neither
    // applier can ask what the return type is inferred as.
    const program = projectCtx.service.getProgram();
    const opts = { filename: proj.target };
    expect(applyTypesToFileCst(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
    expect(applyTypesToFile(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
  });

  // The run saw a value the position's own type says cannot occur. Apply
  // reports it and leaves the code alone: whether the right fix is to widen the
  // type or to stop producing `undefined` is not something an observation can
  // decide.
  it("writes a note instead of an annotation when the run contradicts the checker", () => {
    const proj = makeProject({
      "target.ts":
        "export function f(): string {\n" +
        "  return 'x';\n" +
        "}\n" +
        "export function g() {\n" +
        "  const p = f();\n" +
        "  return p;\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const pEnd = proj.targetSource.indexOf("const p") + "const p".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, pEnd, [["string|undefined"]], { varDecl: true }),
    ];
    const result = applyTypesToFileCst(
      proj.targetSource,
      typeInfo,
      { filename: proj.target },
      program,
    );
    expect(result).toContain(
      "  // @ts-capture[conflict]: `p` observed `undefined`, TypeScript infers `string`\n  const p = f();",
    );
    expect(result).not.toContain("const p: string|undefined");
  });

  it("writes a note from the offset applier too, driven directly", () => {
    const proj = makeProject({
      "target.ts":
        "export function f(): string {\n" +
        "  return 'x';\n" +
        "}\n" +
        "export function g() {\n" +
        "  const p = f();\n" +
        "  return p;\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const pEnd = proj.targetSource.indexOf("const p") + "const p".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, pEnd, [["string|undefined"]], { varDecl: true }),
    ];
    const result = applyTypesToFile(
      proj.targetSource,
      typeInfo,
      { filename: proj.target },
      program,
    );
    expect(result).toContain(
      "  // @ts-capture[conflict]: `p` observed `undefined`, TypeScript infers `string`\n  const p = f();",
    );
    expect(result).not.toContain("const p: string|undefined");
  });

  // The CST applier hands its pass-through entries to the offset applier along
  // with the source it has already rewritten — notes included. If the second
  // pass stripped as well, it would delete what the first one just wrote.
  it("does not strip the notes the CST pass just wrote", () => {
    const proj = makeProject({
      "target.ts":
        "export function f(): string {\n" +
        "  return 'x';\n" +
        "}\n" +
        "export function g() {\n" +
        "  const p = f();\n" +
        "  return p;\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const pEnd = proj.targetSource.indexOf("const p") + "const p".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, pEnd, [["string|undefined"]], { varDecl: true }),
      // A pass-through entry: no CST site owns this offset, so it is handed to
      // the offset applier in a second pass.
      entry(proj.target, 1, [["string"]], {}),
    ];
    const result = applyTypesToFileCst(
      proj.targetSource,
      typeInfo,
      { filename: proj.target },
      program,
    );
    expect(result).toContain("// @ts-capture[conflict]: `p` observed `undefined`");
  });

  describe("outputMode", () => {
    const project = () => {
      const proj = makeProject({
        "target.ts": "export function f(x) {\n  return x.length;\n}\nf('a');\nf('b');\n",
      });
      const program = createProjectVerificationContext(
        proj.fileNames,
        proj.compilerOptions,
        proj.dir,
      ).service.getProgram();
      const xEnd = proj.targetSource.indexOf("(x)") + 2;
      const seen: [string] = ["string"];
      const typeInfo: CollectedTypeInfo = [entry(proj.target, xEnd, [seen, seen])];
      return { proj, program, typeInfo };
    };

    it("annotations: writes the type and no note", () => {
      const { proj, program, typeInfo } = project();
      const out = applyTypesToFileCst(
        proj.targetSource,
        typeInfo,
        { filename: proj.target },
        program,
      );
      expect(out).toContain("function f(x: string)");
      expect(out).not.toContain("@ts-capture");
    });

    it("comments: writes the note and leaves the code alone", () => {
      const { proj, program, typeInfo } = project();
      const out = applyTypesToFileCst(
        proj.targetSource,
        typeInfo,
        { filename: proj.target, infer: { ...INFER_DEFAULTS, outputMode: "comments" } },
        program,
      );
      expect(out).toContain("// @ts-capture[proposal]: `x` would be `string`");
      expect(out).toContain("// @ts-capture:   observed 2 times; TypeScript infers `any`");
      expect(out).toContain("function f(x)");
      expect(out).not.toContain("x: string");
    });

    // Beside the annotation the note drops the type: it is on the next line
    // already, and "would write" would claim something did not happen when it
    // did. What is left is what the annotation cannot say.
    it("both: writes the type, and a note saying only what the type cannot", () => {
      const { proj, program, typeInfo } = project();
      const out = applyTypesToFileCst(
        proj.targetSource,
        typeInfo,
        { filename: proj.target, infer: { ...INFER_DEFAULTS, outputMode: "both" } },
        program,
      );
      expect(out).toContain(
        "// @ts-capture[applied]: `x` observed 2 times; TypeScript infers `any`",
      );
      expect(out).not.toContain("would write");
      expect(out).toContain("function f(x: string)");
    });

    // One line, several sites: a leading note has to name its position, and in
    // `const a = (d) => (d) => (d) => null;` there is one name for four of
    // them. At the site the position is the identifier and the question does
    // not arise.
    it("puts the notes at the sites when a line holds several", () => {
      const src = "const make = (s) => (d) => (e) => e;\n";
      const typeInfo: CollectedTypeInfo = [
        entry("t.ts", src.indexOf("(s)") + 2, [["string"]]),
        entry("t.ts", src.indexOf("(d)") + 2, [["number"]]),
      ];
      const out = applyTypesToFileCst(src, typeInfo, {
        infer: { ...INFER_DEFAULTS, outputMode: "both" },
        filename: "t.ts",
      });
      expect(out).toBe(
        "const make = (s: string /* @ts-capture[applied]: observed once */) => " +
          "(d: number /* @ts-capture[applied]: observed once */) => (e) => e;\n",
      );
    });

    it("keeps the leading note when the line holds one site", () => {
      const src = "const a = 1;\nconst b = f();\n";
      const typeInfo: CollectedTypeInfo = [
        entry("t.ts", src.indexOf("const b") + "const b".length, [["string"]], { varDecl: true }),
      ];
      const out = applyTypesToFileCst(src, typeInfo, {
        infer: { ...INFER_DEFAULTS, outputMode: "both" },
        filename: "t.ts",
      });
      expect(out).toContain("// @ts-capture[applied]: `b` observed once\nconst b: string = f();");
    });

    // Rewriting a line and annotating it inline happen at the same positions,
    // and the ordering is not obvious: a paren-less arrow also inserts `(` and
    // `)` around the parameter. These pin the combinations, and each asserts
    // the result still parses — a misplaced insertion corrupts syntax rather
    // than merely reading badly.
    // `isParseableTypeString`'s guard, one level up: the applier refuses to
    // write an unparseable *type*, and these assert it does not produce an
    // unparseable *file* either.
    const parses = (text: string): boolean => {
      const sf = ts.createSourceFile("t.ts", text, ts.ScriptTarget.Latest, true);
      const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
        .parseDiagnostics;
      return !diags || diags.length === 0;
    };

    it("wraps a paren-less arrow, annotates it, and notes it, twice on one line", () => {
      const src = "const h = a.map(x => x.id).filter(y => y);\n";
      const xAt = src.indexOf("x =>");
      const yAt = src.indexOf("y =>");
      const typeInfo: CollectedTypeInfo = [
        entry("t.ts", xAt + 1, [["string"]], { parens: [xAt, xAt + 1] }),
        entry("t.ts", yAt + 1, [["boolean"]], { parens: [yAt, yAt + 1] }),
      ];
      const out = applyTypesToFileCst(src, typeInfo, {
        infer: { ...INFER_DEFAULTS, outputMode: "both" },
        filename: "t.ts",
      });
      // The note lands outside the closing paren, where the annotation ends.
      expect(out).toBe(
        "const h = a.map((x: string) /* @ts-capture[applied]: observed once */ => x.id)" +
          ".filter((y: boolean) /* @ts-capture[applied]: observed once */ => y);\n",
      );
      expect(parses(out)).toBe(true);
    });

    it("annotates a parameter and a return type on one line, noting both", () => {
      const src = "const k = (a) => a.length;\n";
      const at = src.indexOf("(a)");
      const typeInfo: CollectedTypeInfo = [
        entry("t.ts", at + 2, [["string"]]),
        entry("t.ts", at + 3, [["number"]], { returnType: true, fnRetPos: at + 3 }),
      ];
      const out = applyTypesToFileCst(src, typeInfo, {
        infer: { ...INFER_DEFAULTS, outputMode: "both" },
        filename: "t.ts",
      });
      expect(out).toBe(
        "const k = (a: string /* @ts-capture[applied]: observed once */)" +
          ": number /* @ts-capture[applied]: observed once */ => a.length;\n",
      );
      expect(parses(out)).toBe(true);
    });

    // Strip and write in one pass, against the original source, so the two
    // cannot shift each other's offsets.
    it("removes last run's inline notes while writing this run's", () => {
      const src =
        "const h = a.map((x: string) /* @ts-capture[applied]: observed once */ => x.id)" +
        ".filter((y: boolean) /* @ts-capture[applied]: observed once */ => y);\n";
      const out = applyTypesToFileCst(src, [], {
        infer: { ...INFER_DEFAULTS, outputMode: "both" },
        filename: "t.ts",
      });
      expect(out).toBe("const h = a.map((x: string) => x.id).filter((y: boolean) => y);\n");
      expect(parses(out)).toBe(true);
    });

    // A line is crowded by the notes that survive, not by the candidates that
    // start out. Both declarations here are on one line and both are
    // candidates, but `a: string` cannot annotate `1`, so verify drops it — and
    // the one note left belongs above the line, not inside it.
    it("puts the survivor above the line when verify rejects its neighbour", () => {
      const proj = makeProject({
        "target.ts": 'const a = 1, b = JSON.parse("2");\nexport { a, b };\n',
      });
      const projectCtx = createProjectVerificationContext(
        proj.fileNames,
        proj.compilerOptions,
        proj.dir,
      );
      const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
      const typeInfo: CollectedTypeInfo = [
        entry(proj.target, proj.targetSource.indexOf("a =") + 1, [["string"]], { varDecl: true }),
        entry(proj.target, proj.targetSource.indexOf("b =") + 1, [["number"]], { varDecl: true }),
      ];
      const out = applyTypesToFileCst(proj.targetSource, typeInfo, {
        verify: verifyCtx,
        infer: { ...INFER_DEFAULTS, outputMode: "both" },
      });
      expect(out).not.toContain("a: string");
      expect(out).not.toContain("/* @ts-capture");
      expect(out).toContain(
        '// @ts-capture[applied]: `b` observed once\nconst a = 1, b: number = JSON.parse("2");',
      );
      expect(parses(out)).toBe(true);
    });

    // Conflict notes are notes too. They were left out of the crowding rule,
    // which put two formats on one line — and left them with the naming
    // collision the previews had fixed: two `d`s in a chain, two notes both
    // saying `d`.
    // `secondType` decides whether the inner `d` contradicts or gets annotated:
    // against `any` there is nothing to contradict.
    const chain = (secondType: string) => {
      const proj = makeProject({
        "target.ts":
          `declare function run(f: (d: string) => (d: ${secondType}) => unknown): void;\n` +
          "run(d => d => d);\n",
      });
      const program = createProjectVerificationContext(
        proj.fileNames,
        proj.compilerOptions,
        proj.dir,
      ).service.getProgram();
      const first = proj.targetSource.indexOf("d =>") + 1;
      const second = proj.targetSource.indexOf("d =>", first) + 1;
      return { proj, program, first, second };
    };

    it("puts two conflicts at their sites rather than above the line", () => {
      const { proj, program, first, second } = chain("number");
      const typeInfo: CollectedTypeInfo = [
        entry(proj.target, first, [["undefined"], ["string"]], { parens: [first - 1, first] }),
        entry(proj.target, second, [["undefined"], ["number"]], { parens: [second - 1, second] }),
      ];
      const out = applyTypesToFileCst(
        proj.targetSource,
        typeInfo,
        { filename: proj.target },
        program,
      );
      expect(out).toContain(
        "run(d /* @ts-capture[conflict]: observed `undefined`, TypeScript infers `string` */ " +
          "=> d /* @ts-capture[conflict]: observed `undefined`, TypeScript infers `number` */ => d);",
      );
      expect(parses(out)).toBe(true);
    });

    it("uses one format when a conflict and an annotation share a line", () => {
      const { proj, program, first, second } = chain("any");
      const typeInfo: CollectedTypeInfo = [
        entry(proj.target, first, [["undefined"], ["string"]], { parens: [first - 1, first] }),
        entry(proj.target, second, [["number"]], { parens: [second - 1, second] }),
      ];
      const out = applyTypesToFileCst(
        proj.targetSource,
        typeInfo,
        { filename: proj.target, infer: { ...INFER_DEFAULTS, outputMode: "both" } },
        program,
      );
      expect(out).not.toContain("// @ts-capture");
      expect(out).toContain("[conflict]: observed `undefined`");
      expect(out).toContain("[applied]: observed once");
      expect(parses(out)).toBe(true);
    });

    it("keeps a lone conflict above the line", () => {
      const { proj, program, first } = chain("any");
      const typeInfo: CollectedTypeInfo = [
        entry(proj.target, first, [["undefined"], ["string"]], { parens: [first - 1, first] }),
      ];
      const out = applyTypesToFileCst(
        proj.targetSource,
        typeInfo,
        { filename: proj.target },
        program,
      );
      expect(out).toContain(
        "// @ts-capture[conflict]: `d` observed `undefined`, TypeScript infers `string`\nrun(d =>",
      );
    });

    // The rule lives in one place because both appliers need it. Driven
    // directly, the offset applier has to reach the same answer — a rule added
    // to one path and not the other stays invisible until a project routes
    // through the second, and nest does not.
    it("the offset applier puts a crowded line's notes at the sites too", () => {
      const src = "const k = (a) => a.length;\n";
      const at = src.indexOf("(a)");
      const typeInfo: CollectedTypeInfo = [
        entry("t.ts", at + 2, [["string"]]),
        entry("t.ts", at + 3, [["number"]], { returnType: true, fnRetPos: at + 3 }),
      ];
      const out = applyTypesToFile(src, typeInfo, {
        infer: { ...INFER_DEFAULTS, outputMode: "both" },
        filename: "t.ts",
      });
      expect(out).toBe(
        "const k = (a: string /* @ts-capture[applied]: observed once */)" +
          ": number /* @ts-capture[applied]: observed once */ => a.length;\n",
      );
      expect(parses(out)).toBe(true);
    });

    it("the offset applier keeps a lone note above the line", () => {
      const src = "const a = 1;\nconst b = f();\n";
      const typeInfo: CollectedTypeInfo = [
        entry("t.ts", src.indexOf("const b") + "const b".length, [["string"]], { varDecl: true }),
      ];
      const out = applyTypesToFile(src, typeInfo, {
        infer: { ...INFER_DEFAULTS, outputMode: "both" },
        filename: "t.ts",
      });
      expect(out).toContain("// @ts-capture[applied]: `b` observed once\nconst b: string = f();");
    });

    // A preview that names an annotation apply would not actually write is not
    // a preview. The first run on nest wrote 261 of them against 125 real
    // annotations — the difference being exactly the candidates the batch
    // verify pass rejects.
    it("does not preview an annotation verify would reject", () => {
      const proj = makeProject({ "target.ts": "const x = 1;\n" });
      const projectCtx = createProjectVerificationContext(
        proj.fileNames,
        proj.compilerOptions,
        proj.dir,
      );
      const verifyCtx = createVerificationContext(projectCtx, proj.target, proj.targetSource);
      // `const x = 1` cannot be a `string`; verify rejects it.
      const xEnd = proj.targetSource.indexOf("x") + 1;
      const typeInfo: CollectedTypeInfo = [
        entry(proj.target, xEnd, [["string"]], { varDecl: true }),
      ];
      const out = applyTypesToFileCst(proj.targetSource, typeInfo, {
        verify: verifyCtx,
        infer: { ...INFER_DEFAULTS, outputMode: "comments" },
      });
      expect(out).toBe(proj.targetSource);
    });

    // The preview is scaffolding: an ordinary apply owns every line carrying
    // the marker, so the next run cleans up after the review.
    it("an ordinary apply removes a preview left behind", () => {
      const { proj, program, typeInfo } = project();
      const previewed = applyTypesToFileCst(
        proj.targetSource,
        typeInfo,
        { filename: proj.target, infer: { ...INFER_DEFAULTS, outputMode: "comments" } },
        program,
      );
      expect(previewed).toContain("@ts-capture");
      // Second pass over the previewed text, in the default mode. The offsets
      // the entries carry are into the original source, so this asserts only
      // that the notes are gone.
      const cleaned = applyTypesToFileCst(previewed, [], { filename: proj.target });
      expect(cleaned).not.toContain("@ts-capture");
    });
  });

  it("removes a note whose conflict is gone", () => {
    const proj = makeProject({
      "target.ts":
        "export function f(): string {\n" +
        "  return 'x';\n" +
        "}\n" +
        "export function g() {\n" +
        "  // @ts-capture: `p` observed `undefined`, TypeScript infers `string`\n" +
        "  const p = f();\n" +
        "  return p;\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    // No entry contradicts anything this time.
    const result = applyTypesToFileCst(proj.targetSource, [], { filename: proj.target }, program);
    expect(result).not.toContain("@ts-capture");
    expect(result).toContain("const p = f();");
  });

  // Found by the eval, not by the tests above: nest aliases `this` into a local
  // (`const self: Module = this`) so a class expression can close over it. The
  // checker types that binding `this` too, and writing the class name there
  // erases exactly what it erases on a return type.
  it("never annotates a binding the checker infers as `this`", () => {
    const proj = makeProject({
      "target.ts":
        "export class Module {\n" +
        "  make() {\n" +
        "    const self = this;\n" +
        "    return self;\n" +
        "  }\n" +
        "}\n",
    });
    const program = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    ).service.getProgram();
    const selfEnd = proj.targetSource.indexOf("const self") + "const self".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, selfEnd, [["Module"]], { varDecl: true }),
    ];
    const opts = { filename: proj.target };
    expect(applyTypesToFileCst(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
    expect(applyTypesToFile(proj.targetSource, typeInfo, opts, program)).toBe(proj.targetSource);
  });

  // Control: same shape, same class name written, but the body does not return
  // `this` — so the guard must not fire and the annotation must land. Without
  // this the test above would pass just as well if the applier stopped
  // annotating return types altogether.
  it("still annotates a class-typed return the checker cannot infer", () => {
    const proj = makeProject({
      "target.ts":
        "export class Builder {\n" + "  make(f) {\n" + "    return f;\n" + "  }\n" + "}\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const paramsClose = proj.targetSource.indexOf("make(f)") + "make(f)".length;
    const typeInfo: CollectedTypeInfo = [
      entry(proj.target, paramsClose, [["Builder"]], { returnType: true, fnRetPos: paramsClose }),
    ];
    expect(
      applyTypesToFileCst(
        proj.targetSource,
        typeInfo,
        { filename: proj.target },
        projectCtx.service.getProgram(),
      ),
    ).toContain("make(f): Builder {");
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

describe("a const assertion is never overwritten", () => {
  // `as const` is the author saying "keep this as narrow as possible". A
  // runtime observation can only ever be wider, so the annotation cannot add
  // information — it can only take some away. On nestjs/nest one such
  // annotation turned the exported `EnhancerSubtype` from
  // `"guard" | "interceptor" | "pipe" | "filter"` into `string`, and neither
  // `tsc` nor the project's own suite noticed.
  //
  // Unconditional, unlike skipRedundantAnnotations: a user who asks for
  // redundant annotations is asking for restatement, not for destruction.
  it.each([
    ['const M = { a: "guard" } as const;', "M", "{ a: string }"],
    ['const M = ["a", "b"] as const satisfies string[];', "M", "string[]"],
    ['const M = { [K]: "guard" } as const;', "M", "{ __guards__: string }"],
  ])("leaves %s alone", (source, name, emitted) => {
    const pos = source.indexOf(name) + name.length;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [[emitted]], { varDecl: true })];
    expect(applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE)).toBe(source);
    expect(applyTypesToFile(source, typeInfo, KEEP_INFERABLE)).toBe(source);
  });

  // `unique symbol` is the same narrowing, inferred rather than asked for.
  // Writing `: symbol` widens it away and every `x === THE_SYMBOL` narrowing
  // downstream stops working — one annotation on nestjs/nest's
  // `VERSION_NEUTRAL` produced three compile errors in files that never
  // mention it. Destruction, not restatement, so it does not wait for the flag.
  it.each([["const sym = Symbol('x');"], ["const sym = Symbol.for('x');"]])(
    "leaves %s alone even with the flag off",
    (source) => {
      const pos = source.indexOf("sym") + 3;
      const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["symbol"]], { varDecl: true })];
      expect(applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE)).toBe(source);
      expect(applyTypesToFile(source, typeInfo, KEEP_INFERABLE)).toBe(source);
    },
  );

  // The guard is syntactic, like the rest of this module: a bare `Symbol`
  // identifier and nothing else. This one is the control — if it stops being
  // annotated, the guard has grown teeth it was not given.
  it("still annotates a call that only looks like Symbol", () => {
    const source = "const sym = ns.Symbol('x');";
    const pos = source.indexOf("sym") + 3;
    const typeInfo: CollectedTypeInfo = [entry("test.ts", pos, [["symbol"]], { varDecl: true })];
    expect(applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE)).toContain("const sym: symbol");
  });

  it("still annotates an initializer without the assertion", () => {
    const source = 'const M = { [K]: "guard" };';
    const pos = source.indexOf("M") + 1;
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pos, [["{ __guards__: string }"]], { varDecl: true }),
    ];
    expect(applyTypesToFileCst(source, typeInfo, KEEP_INFERABLE)).toBe(
      'const M: { __guards__: string } = { [K]: "guard" };',
    );
  });
});
