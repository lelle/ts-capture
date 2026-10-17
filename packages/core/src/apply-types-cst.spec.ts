import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { DiscoveredType } from "./collector-contract.js";
import type { CollectedTypeEntry, CollectedTypeInfo, SourceLocation } from "./type-collector.js";

import { applyTypesToFileCst } from "./apply-types-cst.js";
import { INFER_DEFAULTS } from "./configuration.js";
import { newApplyTelemetry } from "./contract.js";
import {
  aliasesDeclared,
  applied,
  nodesOf,
  parseErrors,
  printedAst,
} from "./test-utils/applied.js";

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

// The CST applier and the offset applier read the same observations into the
// same file. Each row is one fixture both are run on; the two outputs must be
// the same program, token for token. A case where the CST applier is more
// capable on purpose is not listed here but asserted on its own below.
const PARITY: Array<
  [string, string, (src: string) => CollectedTypeInfo, { infer?: typeof INFER_DEFAULTS }?]
> = [
  ["a single param", "function foo(a) {}", () => [entry("test.ts", 14, [["string"]])]],
  [
    "several params",
    "function foo(a, b, c) { return a; }",
    () => [
      entry("test.ts", 14, [["number"]]),
      entry("test.ts", 17, [["string"]]),
      entry("test.ts", 20, [["boolean"]]),
    ],
  ],
  [
    "an optional param",
    "function foo(a?) {}",
    () => [entry("test.ts", 15, [["number"], ["undefined"]])],
  ],
  ["a union", "function foo(a) {}", () => [entry("test.ts", 14, [["string"], ["number"]])]],
  [
    "a class method param",
    "class C { foo(x) { return x; } }",
    (src) => [entry("test.ts", src.indexOf("x)") + 1, [["number"]])],
  ],
  [
    "a parameter property",
    "class C { constructor(public x) {} }",
    (src) => [entry("test.ts", src.indexOf("x)") + 1, [["number"]])],
  ],
  [
    "an object binding pattern",
    "function foo({ a, b }) { return a; }",
    (src) => [entry("test.ts", src.indexOf(")"), [["{ a: number, b: number }"]])],
  ],
  [
    "an array binding pattern",
    "function foo([a, b]) { return a + b; }",
    (src) => [entry("test.ts", src.indexOf(")"), [["[number, number]"]])],
  ],
  [
    "a local before a param",
    "let x = 5;\nfunction foo(a) { return a; }",
    (src) => [
      entry("test.ts", src.indexOf("x ") + 1, [["number"]], { varDecl: true }),
      entry("test.ts", src.indexOf("a)") + 1, [["string"]]),
    ],
    KEEP_INFERABLE,
  ],
  [
    "a local before a param, with the redundancy skip on",
    "let x = 5;\nfunction foo(a) { return a; }",
    (src) => [
      entry("test.ts", src.indexOf("x ") + 1, [["number"]], { varDecl: true }),
      entry("test.ts", src.indexOf("a)") + 1, [["string"]]),
    ],
  ],
  [
    "a union with a shape",
    "function foo(a) { return a; }",
    (src) => [entry("test.ts", src.indexOf("a)") + 1, [["{ x: number, y: string }"], ["number"]])],
    KEEP_INFERABLE,
  ],
  [
    "a destructured declaration",
    "let { host, guest } = getProps();",
    (src) => [
      entry("test.ts", src.indexOf("} =") + 1, [["{ host: string, guest: string }"]], {
        varDecl: true,
      }),
    ],
    KEEP_INFERABLE,
  ],
  [
    "a param before a local",
    "function foo(a) { return a; }\nlet x = 5;",
    (src) => [
      entry("test.ts", src.indexOf("a)") + 1, [["string"]]),
      entry("test.ts", src.indexOf("x ") + 1, [["number"]], { varDecl: true }),
    ],
    KEEP_INFERABLE,
  ],
  [
    "two params and a local",
    "let x = 5;\nfunction foo(a, b) { return a + b; }",
    (src) => [
      entry("test.ts", src.indexOf("x ") + 1, [["number"]], { varDecl: true }),
      entry("test.ts", src.indexOf("(a") + 2, [["number"]]),
      entry("test.ts", src.indexOf(", b") + 3, [["number"]]),
    ],
    KEEP_INFERABLE,
  ],
  [
    "a return type",
    "function foo() { return 5; }",
    () => [entry("test.ts", 14, [["number"]], { returnType: true })],
  ],
  [
    "an async return type",
    "async function foo() { return 5; }",
    (src) => [
      entry("test.ts", src.indexOf(")") + 1, [["number"]], { returnType: true, async: true }),
    ],
  ],
  [
    "a param and a return type",
    "function foo(a) { return a; }",
    (src) => [
      entry("test.ts", src.indexOf("a)") + 1, [["string"]]),
      entry("test.ts", src.indexOf(")") + 1, [["string"]], { returnType: true }),
    ],
  ],
  [
    "a generator's param",
    "function* gen(a) { yield a; }",
    (src) => [entry("test.ts", src.indexOf("a)") + 1, [["number"]])],
  ],
  [
    "an optional param observed only as undefined",
    "function foo(a?) {}",
    () => [entry("test.ts", 15, [["undefined"]])],
  ],
  [
    "a `let` local",
    "let x = 5;",
    () => [entry("test.ts", 5, [["number"]], { varDecl: true })],
    KEEP_INFERABLE,
  ],
  [
    "a `const` local",
    'const name = "hi";',
    (src) => [entry("test.ts", src.indexOf("name") + 4, [["string"]], { varDecl: true })],
    KEEP_INFERABLE,
  ],
  [
    "a class field",
    "class C { value = 42; }",
    (src) => [entry("test.ts", src.indexOf("value") + 5, [["number"]], { varDecl: true })],
    KEEP_INFERABLE,
  ],
  [
    "a local whose initializer is a function",
    "const fn = (x) => x + 1;",
    (src) => [
      entry("test.ts", src.indexOf("fn") + 2, [["(x: unknown) => unknown"]], { varDecl: true }),
    ],
  ],
  [
    "a const literal, with the redundancy skip on",
    "const FLAG = 'on';",
    (src) => [entry("test.ts", src.indexOf("FLAG") + 4, [["string"]], { varDecl: true })],
  ],
  [
    "a `let` local, with the redundancy skip on",
    "let x = 5;",
    () => [entry("test.ts", 5, [["number"]], { varDecl: true })],
  ],
  [
    "a local, a param and a return type",
    "let n = 0;\nfunction foo(a) { return a; }",
    (src) => [
      entry("test.ts", src.indexOf("n ") + 1, [["number"]], { varDecl: true }),
      entry("test.ts", src.indexOf("a)") + 1, [["string"]]),
      entry("test.ts", src.indexOf(")") + 1, [["string"]], { returnType: true }),
    ],
    KEEP_INFERABLE,
  ],
  [
    "a paren-less arrow param",
    "const inc = x => x + 1;",
    (src) => {
      const pos = src.indexOf("x ") + 1;
      return [entry("test.ts", pos, [["number"]], { arrow: true, parens: [pos - 1, pos] })];
    },
  ],
  [
    "a parenthesised arrow param",
    "const inc = (x) => x + 1;",
    (src) => [entry("test.ts", src.indexOf("x)") + 1, [["number"]])],
  ],
  [
    "a `this` type",
    "function greet() { return this.text; }",
    () => [entry("test.ts", 15, [["Date"]], { thisType: true })],
  ],
  [
    "a `this` type beside a param, with the separator flag",
    "function greet(name) { return this.text + name; }",
    () => [
      entry("test.ts", 15, [["Date"]], { thisType: true, thisNeedsComma: true }),
      entry("test.ts", 19, [["string"]]),
    ],
  ],
  [
    "a `this` type at no function",
    "function greet() { return this.text; }",
    () => [entry("test.ts", 999, [["Date"]], { thisType: true })],
  ],
];

describe("the CST and offset appliers agree", () => {
  it.each(PARITY)("on %s", (_, source, entries, options) => {
    const cst = applied(source, entries(source), options);
    const offset = applied(source, entries(source), { ...options, applier: "offset" });
    expect(printedAst(offset.text)).toBe(printedAst(cst.text));
  });
});

describe("applyTypesToFileCst — param annotations via AST lookup", () => {
  it("annotates a single param", () => {
    const out = applied("function foo(a) {}", [entry("test.ts", 14, [["string"]])]);
    expect(out).toAnnotate("a", "string");
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
    for (const applier of ["cst", "offset"] as const) {
      const out = applied(source, typeInfo, { applier });
      expect(parseErrors(out)).toEqual([]);
      expect(out).toAnnotate("resolve", "Function");
    }
  });

  it("annotates several params", () => {
    const out = applied("function foo(a, b, c) { return a; }", [
      entry("test.ts", 14, [["number"]]),
      entry("test.ts", 17, [["string"]]),
      entry("test.ts", 20, [["boolean"]]),
    ]);
    expect(out).toAnnotate("a", "number");
    expect(out).toAnnotate("b", "string");
    expect(out).toAnnotate("c", "boolean");
  });

  it("keeps an optional param optional and drops the undefined it implies", () => {
    // pos accounts for the `?`: name.end (14) + 1 = 15
    const out = applied("function foo(a?) {}", [entry("test.ts", 15, [["number"], ["undefined"]])]);
    expect(out).toAnnotate("a", "number");
    expect(nodesOf(out, ts.isParameter)[0].questionToken).toBeDefined();
  });

  it("idempotency: re-apply on already-annotated param is a no-op", () => {
    // Same pos as before annotation — but the AST now sees `a: string`,
    // so paramSites doesn't index this position.
    const source = "function foo(a: string) {}";
    expect(applied(source, [entry("test.ts", 14, [["string"]])]).text).toBe(source);
  });

  it("joins several observations into a union", () => {
    const out = applied("function foo(a) {}", [entry("test.ts", 14, [["string"], ["number"]])]);
    expect(out).toAnnotate("a", "number | string");
  });

  it("annotates a class method param", () => {
    const source = "class C { foo(x) { return x; } }";
    const out = applied(source, [entry("test.ts", source.indexOf("x)") + 1, [["number"]])]);
    expect(out).toAnnotate("x", "number");
  });

  it("annotates a parameter property and keeps its modifier", () => {
    const source = "class C { constructor(public x) {} }";
    const out = applied(source, [entry("test.ts", source.indexOf("x)") + 1, [["number"]])]);
    expect(out).toAnnotate("x", "number");
    const modifiers = ts.getModifiers(nodesOf(out, ts.isParameter)[0]) ?? [];
    expect(modifiers.map((m) => m.kind)).toEqual([ts.SyntaxKind.PublicKeyword]);
  });

  it("annotates an object binding pattern at the pattern's end", () => {
    const source = "function foo({ a, b }) { return a; }";
    const out = applied(source, [
      entry("test.ts", source.indexOf(")"), [["{ a: number, b: number }"]]),
    ]);
    expect(out).toAnnotate("{ a, b }", "{ a: number; b: number }");
  });

  it("annotates an array binding pattern", () => {
    const source = "function foo([a, b]) { return a + b; }";
    const out = applied(source, [entry("test.ts", source.indexOf(")"), [["[number, number]"]])]);
    expect(out).toAnnotate("[a, b]", "[number, number]");
  });

  it("annotates a param and a local in one file", () => {
    const source = "let x = 5;\nfunction foo(a) { return a; }";
    const out = applied(
      source,
      [
        entry("test.ts", source.indexOf("x ") + 1, [["number"]], { varDecl: true }),
        entry("test.ts", source.indexOf("a)") + 1, [["string"]]),
      ],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("x", "number");
    expect(out).toAnnotate("a", "string");
  });

  // Presentation, so the text is the claim: this is the punctuation a
  // formatter would leave alone.
  it("writes separators a formatter would leave alone", () => {
    const source = "function foo(a) { return a; }";
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("a)") + 1, [["{ x: number, y: string }"], ["number"]])],
      KEEP_INFERABLE,
    );
    expect(out.text).toContain("a: number | { x: number; y: string }");
  });

  it("annotates a destructured declaration", () => {
    const source = "let { host, guest } = getProps();";
    const out = applied(
      source,
      [
        entry("test.ts", source.indexOf("} =") + 1, [["{ host: string, guest: string }"]], {
          varDecl: true,
        }),
      ],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("{ host, guest }", "{ host: string; guest: string }");
  });

  // The local goes through the offset applier after the CST pass inserted
  // before it; its position has to move with the insertion.
  it("places a local that follows a param", () => {
    const source = "function foo(a) { return a; }\nlet x = 5;";
    const out = applied(
      source,
      [
        entry("test.ts", source.indexOf("a)") + 1, [["string"]]),
        entry("test.ts", source.indexOf("x ") + 1, [["number"]], { varDecl: true }),
      ],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("a", "string");
    expect(out).toAnnotate("x", "number");
  });

  // The offsets in a types.json are pristine: they describe the source as it
  // was when the run observed it, before any note a previous apply wrote above
  // a line. Stripping those notes is what restores those coordinates, so a
  // removal must NOT shift a pass-through entry — only the insertions this run
  // makes do. `rebaseOffset` filters replacements down to insertions for that
  // reason, and a rebase that also subtracted the removals would drop the
  // annotation instead (the `--comments` → review → `apply` workflow is the
  // path that has notes in the file to begin with).
  it("a note left by a previous run does not move a pass-through offset", () => {
    const pristine = "function f(a) {}\nexport function* gen() {}\n";
    // `a` is a CST site and inserts; a generator's return type is not indexed,
    // so it routes to passThrough and its offset goes through the rebase.
    const typeInfo: CollectedTypeInfo = [
      entry("test.ts", pristine.indexOf("a)") + 1, [["string"]]),
      entry("test.ts", pristine.indexOf("gen()") + "gen()".length, [["Generator<number>"]], {
        returnType: true,
      }),
    ];
    // Same entries, same offsets — but a stale note now sits between the two
    // sites, so the removal and the insertion straddle the pass-through entry.
    const noted =
      "function f(a) {}\n" +
      "// @ts-capture[proposal]: `gen` return would be `Generator<number>`\n" +
      "export function* gen() {}\n";
    for (const source of [pristine, noted]) {
      const out = applied(source, typeInfo);
      expect(out).toAnnotate("a", "string");
      expect(out).toAnnotate({ returnOf: "gen" }, "Generator<number>");
      expect(out.text).not.toContain("@ts-capture");
    }
  });

  it("leaves a redundant local alone and annotates the param after it", () => {
    const source = "let x = 5;\nfunction foo(a) { return a; }";
    const out = applied(source, [
      entry("test.ts", source.indexOf("x ") + 1, [["number"]], { varDecl: true }),
      entry("test.ts", source.indexOf("a)") + 1, [["string"]]),
    ]);
    expect(out).toLeaveUntyped("x");
    expect(out).toAnnotate("a", "string");
  });

  it("places two params and a local", () => {
    const source = "let x = 5;\nfunction foo(a, b) { return a + b; }";
    const out = applied(
      source,
      [
        entry("test.ts", source.indexOf("x ") + 1, [["number"]], { varDecl: true }),
        entry("test.ts", source.indexOf("(a") + 2, [["number"]]),
        entry("test.ts", source.indexOf(", b") + 3, [["number"]]),
      ],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("x", "number");
    expect(out).toAnnotate("a", "number");
    expect(out).toAnnotate("b", "number");
  });

  it("entry with no AST match (stale offset): silently skipped", () => {
    const source = "function foo(a) {}";
    expect(applied(source, [entry("test.ts", 99, [["string"]])]).text).toBe(source);
  });

  it("annotates a return type", () => {
    // pos right after `)` of `function foo()` — `(` at 12, `)` at 13, retPos=14
    const out = applied("function foo() { return 5; }", [
      entry("test.ts", 14, [["number"]], { returnType: true }),
    ]);
    expect(out).toAnnotate({ returnOf: "foo" }, "number");
  });

  it("returnType idempotency: AST-native skip when function already has a return type", () => {
    const source = "function foo(): number { return 5; }";
    const typeInfo = [
      entry("test.ts", source.indexOf(")") + 1, [["number"]], { returnType: true }),
    ];
    expect(applied(source, typeInfo).text).toBe(source);
  });

  it("wraps an async return type in a Promise", () => {
    const source = "async function foo() { return 5; }";
    const out = applied(source, [
      entry("test.ts", source.indexOf(")") + 1, [["number"]], { returnType: true, async: true }),
    ]);
    expect(out).toAnnotate({ returnOf: "foo" }, "Promise<number>");
  });

  it("annotates a param and the return type of one function", () => {
    const source = "function foo(a) { return a; }";
    const out = applied(source, [
      entry("test.ts", source.indexOf("a)") + 1, [["string"]]),
      entry("test.ts", source.indexOf(")") + 1, [["string"]], { returnType: true }),
    ]);
    expect(out).toAnnotate("a", "string");
    expect(out).toAnnotate({ returnOf: "foo" }, "string");
  });

  it("annotates a generator's param", () => {
    // The transformer doesn't instrument generator return types; its params
    // are ordinary sites.
    const source = "function* gen(a) { yield a; }";
    const out = applied(source, [entry("test.ts", source.indexOf("a)") + 1, [["number"]])]);
    expect(out).toAnnotate("a", "number");
  });

  it("empty typeInfo returns source unchanged", () => {
    const source = "function foo(a) {}";
    expect(applied(source, []).text).toBe(source);
  });

  it("leaves an optional param alone when every observation was undefined", () => {
    const out = applied("function foo(a?) {}", [entry("test.ts", 15, [["undefined"]])]);
    expect(out).toLeaveUntyped("a");
  });
});

describe("applyTypesToFileCst — varDecl + class-field annotations via AST lookup", () => {
  // varDecl + PropertyDeclaration entries indexed by name.end.
  // AST-native idempotency (skip when node.type set), function-RHS
  // guard (skip when RHS is a function expression), and
  // skipRedundantAnnotations (skip when TS would already infer the same
  // type) are all expressed against the AST.

  it("annotates `let x = 5`", () => {
    const out = applied(
      "let x = 5;",
      [entry("test.ts", 5, [["number"]], { varDecl: true })],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("x", "number");
  });

  it('annotates `const name = "hi"`', () => {
    const source = 'const name = "hi";';
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("name") + 4, [["string"]], { varDecl: true })],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("name", "string");
  });

  describe("a field set from a constructor param gets the param's type", () => {
    const source = `class Counter {
  count;
  constructor(initial) {
    this.count = initial;
  }
}`;
    const initialEnd = source.indexOf("initial)") + "initial".length;

    it.each([
      ["without a program", {}],
      ["with a program", { project: true }],
      ["with the type-check oracle", { verify: true }],
    ])("%s", (_, options) => {
      const out = applied(source, [entry("test.ts", initialEnd, [["number"]])], options);
      expect(out).toAnnotate("initial", "number");
      expect(out).toAnnotate("count", "number");
    });

    it.each([
      ["without a program", {}],
      ["with a program", { project: true }],
      ["with the type-check oracle", { verify: true }],
    ])("writes the field's type once when the param's type is a named shape, %s", (_, options) => {
      const named = `interface Opts { a: number; b: string }
class Holder {
  opts;
  constructor(initial) {
    this.opts = initial;
  }
}`;
      const pos = named.indexOf("initial)") + "initial".length;
      const out = applied(named, [entry("test.ts", pos, [["{ a: number; b: string }"]])], options);
      // `Opts | Opts` is the same type as `Opts`, so the spelling is compared.
      expect(out.text).toBe(
        named.replace("opts;", "opts: Opts;").replace("(initial)", "(initial: Opts)"),
      );
    });
  });

  it("annotates a class field initializer", () => {
    const source = "class C { value = 42; }";
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("value") + 5, [["number"]], { varDecl: true })],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("value", "number");
  });

  it("idempotency: re-apply on already-typed varDecl is a no-op (AST-native)", () => {
    const source = "let x: number = 5;";
    expect(applied(source, [entry("test.ts", 5, [["number"]], { varDecl: true })]).text).toBe(
      source,
    );
  });

  it("idempotency: re-apply on already-typed class field is a no-op", () => {
    const source = "class C { value: bigint = 42n; }";
    const typeInfo = [
      entry("test.ts", source.indexOf("value") + 5, [["number"]], { varDecl: true }),
    ];
    expect(applied(source, typeInfo).text).toBe(source);
  });

  it("skips outer annotation when varDecl RHS is a function expression", () => {
    // `const fn = (x) => x` — the outer would be `(arg: unknown) => unknown`,
    // contravariantly incompatible with whatever inner observations
    // produce. CST routes the entry to a site whose rhsIsFunction=true
    // and drops it; no insertion in the AST path.
    const source = "const fn = (x) => x + 1;";
    const typeInfo = [
      entry("test.ts", source.indexOf("fn") + 2, [["(x: unknown) => unknown"]], { varDecl: true }),
    ];
    expect(applied(source, typeInfo).text).toBe(source);
  });

  it("skips outer annotation when RHS is a function expression (function keyword)", () => {
    const source = "const fn = function (n) { return n; };";
    const typeInfo = [
      entry("test.ts", source.indexOf("fn") + 2, [["(n: unknown) => unknown"]], { varDecl: true }),
    ];
    expect(applied(source, typeInfo).text).toBe(source);
  });

  it("function-RHS guard does NOT fire for non-function RHS", () => {
    const source = "const count = 42;";
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("count") + 5, [["number"]], { varDecl: true })],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("count", "number");
  });

  it("skipRedundantAnnotations (off): annotation lands as usual", () => {
    const out = applied("let x = 5;", [entry("test.ts", 5, [["number"]], { varDecl: true })], {
      infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: false },
    });
    expect(out).toAnnotate("x", "number");
  });

  // Defaults matter here: annotating `const X = 'lit'` with `: string` does not
  // add information, it destroys it — TypeScript already infers the literal
  // type `'lit'`, and the annotation widens it. A run on nestjs/nest produced
  // 105 such widening annotations, ~8% of the whole diff.
  it("skipRedundantAnnotations is on by default: a const literal keeps its narrow type", () => {
    const source = "const FLAG = 'on';";
    const typeInfo = [
      entry("test.ts", source.indexOf("FLAG") + 4, [["string"]], { varDecl: true }),
    ];
    const out = applied(source, typeInfo);
    expect(out).toLeaveUntyped("FLAG");
    expect(out).toTypeAs("FLAG", '"on"');
  });

  it.each([
    ["`let x = 5`", "let x = 5;"],
    ["`const x = 5`", "const x = 5;"],
    ["a `readonly` class field with a primitive", "class C { readonly x = 5; }"],
  ])("skipRedundantAnnotations (on): %s skips the restatement", (_, source) => {
    const pos = source.indexOf("x = 5") + 1;
    const out = applied(source, [entry("test.ts", pos, [["number"]], { varDecl: true })], {
      infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: true },
    });
    expect(out).toLeaveUntyped("x");
  });

  it("skipRedundantAnnotations (on): `as const` on object literal SKIPS annotation", () => {
    const source = "const X = { a: 1 } as const;";
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("X") + 1, [["{ a: number }"]], { varDecl: true })],
      { infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: true } },
    );
    expect(out).toLeaveUntyped("X");
  });

  it("annotates a local, a param and a return type in one file", () => {
    const source = "let n = 0;\nfunction foo(a) { return a; }";
    const out = applied(
      source,
      [
        entry("test.ts", source.indexOf("n ") + 1, [["number"]], { varDecl: true }),
        entry("test.ts", source.indexOf("a)") + 1, [["string"]]),
        entry("test.ts", source.indexOf(")") + 1, [["string"]], { returnType: true }),
      ],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("n", "number");
    expect(out).toAnnotate("a", "string");
    expect(out).toAnnotate({ returnOf: "foo" }, "string");
  });
});

describe("applyTypesToFileCst — paren-less arrow params + thisType (final routing items)", () => {
  // Paren-less single-param arrows (`x => body`) need both an opening `(` and
  // a `: T)` insert, and `this` parameters need `this: T` (or `this: T, ` if
  // other params follow). The parens and the separator are text, and the
  // claim about them is that the result parses with the annotation in place.

  it("paren-less arrow param: `x => x + 1` wraps with parens", () => {
    const source = "const inc = x => x + 1;";
    const pos = source.indexOf("x ") + 1;
    const out = applied(source, [
      entry("test.ts", pos, [["number"]], { arrow: true, parens: [pos - 1, pos] }),
    ]);
    expect(out).toAnnotate("x", "number");
    expect(out.text).toContain("(x: number) =>");
  });

  // Both inserts target the same offset (a paren-less arrow has
  // retPos === parameters.end === paramPos), and the CST priority ordering
  // (-1 for return) resolves the collision to `(x: T1): T2 => body`. The
  // offset applier's position guard requires `)` before a return type, so it
  // skips the return here; this is a case where the CST applier is more
  // capable on purpose and parity is not asserted.
  it("paren-less arrow + return type: both land inside the parens", () => {
    const source = "const inc = x => x + 1;";
    const pos = source.indexOf("x ") + 1;
    const out = applied(source, [
      entry("test.ts", pos, [["number"]], { arrow: true, parens: [pos - 1, pos] }),
      entry("test.ts", pos, [["number"]], { returnType: true }),
    ]);
    expect(out).toAnnotate("x", "number");
    expect(out).toAnnotate({ returnOf: "inc" }, "number");
    expect(out.text).toContain("(x: number): number =>");
  });

  it("regular paren'd arrow param is not wrapped again", () => {
    const source = "const inc = (x) => x + 1;";
    const out = applied(source, [entry("test.ts", source.indexOf("x)") + 1, [["number"]])]);
    expect(out).toAnnotate("x", "number");
    expect(out.text).toContain("= (x: number) =>");
  });

  it("thisType: `function greet() { return this.text; }` gets `this: Date`", () => {
    // parameters.pos is right after `(` — offset 15
    const out = applied("function greet() { return this.text; }", [
      entry("test.ts", 15, [["Date"]], { thisType: true }),
    ]);
    expect(out).toAnnotate("this", "Date");
  });

  // The transformer sets `thisNeedsComma` when the function already has
  // params and the offset applier relies on it; the CST path reads
  // `node.parameters.length > 0` from the AST, so the separator is right with
  // or without the flag. That it parses is the claim.
  it.each([
    ["with the separator flag", { thisType: true, thisNeedsComma: true }],
    ["without the separator flag", { thisType: true }],
  ])("thisType beside a param, %s", (_, opts) => {
    const out = applied("function greet(name) { return this.text + name; }", [
      entry("test.ts", 15, [["Date"]], opts),
      entry("test.ts", 19, [["string"]]),
    ]);
    expect(parseErrors(out)).toEqual([]);
    expect(out).toAnnotate("this", "Date");
    expect(out).toAnnotate("name", "string");
  });

  it("thisType: pos with no matching function falls through to passThrough", () => {
    // Nothing in the AST index at this pos; the offset applier gets it and
    // its own position guard skips it too.
    const source = "function greet() { return this.text; }";
    expect(applied(source, [entry("test.ts", 999, [["Date"]], { thisType: true })]).text).toBe(
      source,
    );
  });
});

describe("applyTypesToFileCst — TypeChecker verify integration", () => {
  // Mirrors apply-types-verify.spec.ts: drive the CST applier with a real
  // LanguageService-backed verify context built from a tiny on-disk project,
  // or with a Program alone for the checker-backed gates.

  // --- checker-backed redundancy suppression -------------------------------
  //
  // The predicate itself is covered in redundant-annotation.spec.ts. These
  // prove the wiring: with a real Program in hand the applier must drop
  // annotations TypeScript already implies, at all three site kinds, and must
  // keep the ones that carry information the checker does not have.

  // Deliberately NOT a literal initializer: `inferTypeFromInitializer` already
  // suppresses those syntactically, so a literal fixture would pass with the
  // checker disabled and prove nothing. A call expression is invisible to the
  // syntactic path — only the checker knows `g()` returns a string.
  it("drops a varDecl annotation the checker already infers from a call", () => {
    const src = 'function g(): string {\n  return "x";\n}\nexport const v = g();\n';
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("const v") + 7, [["string"]], { varDecl: true })],
      {
        project: true,
      },
    );
    expect(out).toLeaveUntyped("v");
    expect(out).toTypeAs("v", "string");
  });

  // The gate covered params, return types and bindings, and `this` sites got
  // none of it — the one site kind whose whole subject is `this`. Inside a
  // class method TypeScript already types `this` polymorphically, so writing
  // the class the run happened to see is the exact trade the polymorphic-this
  // rule exists to refuse: every subclass caller gets the base back.
  it("drops a `this` annotation where the checker has polymorphic `this`", () => {
    const src = "export class Builder {\n  x = 1;\n  run() {\n    return this.x;\n  }\n}\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("run(") + "run(".length, [["Builder"]], { thisType: true })],
      { project: true },
    );
    expect(out).toLeaveUntyped("this");
    expect(out.text).toBe(src);
  });

  // The mirror: a loose function has no polymorphic `this` to lose — the
  // checker types it `any`, which is the hole ts-capture exists to fill.
  it("keeps a `this` annotation the checker has nothing better for", () => {
    const src = "export function greet() {\n  return this.text;\n}\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("greet(") + "greet(".length, [["Date"]], { thisType: true })],
      { project: true },
    );
    expect(out).toAnnotate("this", "Date");
  });

  // `emitConflictComments` is documented as a flag about *notes* — the site
  // gets no annotation either way. It gated the question instead of the
  // answer, so turning notes off stopped the gate asking, the site fell
  // through to the rules below, and apply wrote the very annotation it had
  // determined contradicts the project's own types. Quieting the output must
  // not change the code.
  it("suppresses a contradicted annotation even with notes turned off", () => {
    const src = "declare const s: string;\nexport const a = s;\n";
    const info = [
      entry("target.ts", src.indexOf("const a") + "const a".length, [["string|undefined"]], {
        varDecl: true,
      }),
    ];

    const withNotes = applied(src, info, { project: true });
    expect(withNotes.text).toContain("@ts-capture[conflict]");
    expect(withNotes).toLeaveUntyped("a");

    const quiet = applied(src, info, {
      project: true,
      infer: { ...INFER_DEFAULTS, emitConflictComments: false },
    });
    expect(quiet.text).not.toContain("@ts-capture");
    expect(quiet).toLeaveUntyped("a");
  });

  // Apply owns every line carrying the marker: it removes the ones it finds
  // and writes the ones that hold now. Removal was gated on
  // `emitConflictComments` while preview notes are written on `outputMode`,
  // so a supported combination wrote notes nothing ever took away — each run
  // stacking a fresh copy above the line, forever.
  it("rewrites its notes rather than stacking them, whatever gates them", () => {
    const src = "function foo(a) { return a; }";
    const typeInfo: CollectedTypeInfo = [entry("test.ts", src.indexOf("(a)") + 2, [["number"]])];
    const markers = (text: string): number => (text.match(/@ts-capture/g) ?? []).length;

    for (const emitConflictComments of [true, false]) {
      const infer = { ...INFER_DEFAULTS, outputMode: "comments" as const, emitConflictComments };
      let out = applyTypesToFileCst(src, typeInfo, { infer });
      const first = markers(out);
      expect(first).toBeGreaterThan(0);
      out = applyTypesToFileCst(out, typeInfo, { infer });
      out = applyTypesToFileCst(out, typeInfo, { infer });
      expect(markers(out)).toBe(first);
    }
  });

  it("drops a contextually typed Array.prototype callback param", () => {
    const src = "const xs: string[] = [];\nexport const ys = xs.map(v => v.length);\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("(v =>") + 2, [["string"]], { arrow: true })],
      {
        project: true,
      },
    );
    expect(out).toLeaveUntyped("v");
    expect(out).toTypeAs("v", "string");
    // ...and no orphaned parens either: wrapping `v` without annotating it is
    // pure diff noise.
    expect(out.text).toBe(src);
  });

  // The skip above is by method name, on the premise that the receiver's
  // element type reaches the callback. An untyped receiver has none to give.
  it("types an Array.prototype callback param its receiver leaves as any", () => {
    const src = "export function skus(cart) {\n  return cart.lines.map((line) => line.sku);\n}\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("(line)") + 5, [["{ sku: string }"]], { arrow: true })],
      {
        project: true,
      },
    );
    expect(out).toTypeAs("line", "{ sku: string }");
    expect(out.text).toContain("(line: { sku: string }) =>");
  });

  // An accumulator is not an element. Where the checker has it as any —
  // seeded with `Object.create(null)`, say — what was observed is whatever the
  // callers built up, as often a test's object as a contract.
  it("leaves a reduce accumulator the checker has as any alone", () => {
    const src =
      "export function index(source) {\n" +
      "  return Object.keys(source).reduce((found, key) => {\n" +
      "    found[key] = source[key];\n" +
      "    return found;\n" +
      "  }, Object.create(null));\n" +
      "}\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("(found,") + 6, [["{ foo?: number }"]], { arrow: true })],
      {
        project: true,
      },
    );
    expect(out).toLeaveUntyped("found");
  });

  it("types the element of a reduce on an untyped receiver", () => {
    const src =
      "export function total(cart) {\n" +
      "  return cart.lines.reduce((sum, line) => sum + line.price, 0);\n" +
      "}\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("line)") + 4, [["{ price: number }"]], { arrow: true })],
      {
        project: true,
      },
    );
    expect(out).toTypeAs("line", "{ price: number }");
  });

  it("drops a return-type annotation the body already implies", () => {
    const src = 'export function greet() {\n  return "hi";\n}\n';
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("()") + 2, [["string"]], { returnType: true })],
      {
        project: true,
      },
    );
    expect(out).toLeaveUntyped({ returnOf: "greet" });
  });

  // The wrap for a paren-less arrow is emitted separately from the annotation
  // so it survives *one* entry being skipped while a sibling still lands. When
  // nothing lands at that position the parens are pure noise — 175 such lines
  // in a nest run, 36% of the whole diff.
  it("does not wrap a paren-less arrow param when the annotation is suppressed", () => {
    const src = "const xs: { a: number }[] = [];\nexport const ys = xs.map(v => v.a);\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("(v =>") + 2, [["{ a: number }"]], { arrow: true })],
      {
        project: true,
      },
    );
    expect(out.text).toBe(src);
  });

  // The guard on the guard: a paren-less arrow whose *param* annotation is
  // dropped but whose *returnType* annotation lands still needs the parens —
  // `v: number => body` is a syntax error. Deferring the wrap must not lose
  // this case.
  it("still wraps a paren-less arrow when a sibling annotation lands", () => {
    const source = "const ys = xs.map(v => v.length);";
    const paramPos = source.indexOf("(v =>") + 2;
    const out = applied(source, [
      // Rejected: `Unknowable` is not a type name in scope.
      entry("test.ts", paramPos, [["Unknowable"]], { arrow: true }),
      // Accepted, and lands at the same offset.
      entry("test.ts", paramPos, [["number"]], { returnType: true }),
    ]);
    expect(out).toLeaveUntyped("v");
    expect(nodesOf(out, ts.isArrowFunction)[0].type?.getText(out.sf)).toBe("number");
    expect(out.text).toContain("(v): number =>");
    expect(parseErrors(out)).toEqual([]);
  });

  it("still annotates a parameter the checker only knows as any", () => {
    const src = "export function use(p) {\n  return p;\n}\n";
    const out = applied(src, [entry("target.ts", src.indexOf("(p)") + 2, [["string"]])], {
      project: true,
    });
    expect(out).toAnnotate("p", "string");
  });

  it("still annotates when the run observed more than the checker infers", () => {
    const src = "export function use(p) {\n  return p;\n}\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("(p)") + 2, [["string"], ["number"]])],
      {
        project: true,
      },
    );
    expect(out).toAnnotate("p", "number | string");
  });

  it("accepts a sound annotation through the CST path", () => {
    const src = "function id(a) { return a; }\n";
    // `string`, not `unknown`: the subject is the CST verify path, and a
    // vacuous type is dropped before verify ever sees it.
    const out = applied(src, [entry("target.ts", src.indexOf("(a)") + 2, [["string"]])], {
      verify: true,
    });
    expect(out).toAnnotate("a", "string");
  });

  it("rejects an annotation that introduces a type error (varDecl narrowed below value)", () => {
    // `const x = 1` cannot be annotated `: string` — TS rejects.
    const src = "const x = 1;\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("x") + 1, [["string"]], { varDecl: true })],
      {
        verify: true,
      },
    );
    expect(out).toLeaveUntyped("x");
    expect(out.text).toBe(src);
  });

  it("mixed batch: accepted candidates land, rejected ones drop", () => {
    // Two annotations in one file: `a: number` is legal, `b: string`
    // is illegal (b's initializer is 2). Verify must accept a, drop b.
    const src = "const a = 1;\nconst b = 2;\n";
    const out = applied(
      src,
      [
        entry("target.ts", src.indexOf("a") + 1, [["number"]], { varDecl: true }),
        entry("target.ts", src.indexOf("b") + 1, [["string"]], { varDecl: true }),
      ],
      { ...KEEP_INFERABLE, verify: true },
    );
    expect(out).toAnnotate("a", "number");
    expect(out).toLeaveUntyped("b");
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
    const src =
      "export const provider = { fetch: () => Promise.resolve(42) };\n" +
      "export type Provider = typeof provider;\n";
    // Insert `: Promise<unknown>` as the return type of `fetch`'s arrow.
    // pos = the `)` of `()` in `fetch: () =>`.
    const paramsClose = src.indexOf(")", src.indexOf("fetch: ()")) + 1;
    const out = applied(
      src,
      [
        entry("target.ts", paramsClose, [["Promise<unknown>"]], {
          returnType: true,
          async: true,
          fnRetPos: paramsClose,
        }),
      ],
      {
        verify: true,
        files: {
          "index.ts": "export * from './target';\n",
          "consumer.ts":
            "import { Provider } from './index';\n" +
            "declare const p: Provider;\n" +
            "async function use() { const n: number = await p.fetch(); return n; }\n",
        },
      },
    );
    // Oracle rejects via the transitive scan: consumer.ts's
    // `const n: number = await p.fetch()` would fail if fetch is
    // typed `Promise<unknown>`. Source unchanged.
    expect(out.text).toBe(src);
  });

  it("oracle catches the emit-quality regression where a structural object of useless-arrow methods narrows binding", () => {
    // Previously: `emittedHasUselessArrowMethod` skipped any
    // structural-object annotation containing `() => unknown`
    // method signatures, because burning that onto a varDecl
    // shadows the consumer's declared interface (DataProvider /
    // AuthProvider). With the transitive scan the oracle
    // catches the resulting consumer-side type errors directly.
    const src =
      "interface Provider { create: () => string; getList: () => number[]; }\n" +
      "declare function makeProvider(): Provider;\n" +
      "export const provider = makeProvider();\n";
    // Probe: annotate `provider` with a structural object that drops
    // `getList`. Consumer breaks because `provider.getList` no longer
    // exists on the narrower type.
    const out = applied(
      src,
      [
        entry(
          "target.ts",
          src.indexOf("provider = ") + "provider".length,
          [["{ create: (resource: unknown) => unknown }"]],
          {
            varDecl: true,
          },
        ),
      ],
      {
        verify: true,
        files: {
          "index.ts": "export * from './target';\n",
          "consumer.ts":
            "import { provider } from './index';\n" +
            "const result: number[] = provider.getList();\n",
        },
      },
    );
    expect(out).toLeaveUntyped("provider");
  });

  it("oracle catches returnType narrowing below a `return undefined` branch", () => {
    // The `narrowingReturnTypeFns` heuristic (removed) used to
    // scan function bodies for `return undefined` / bare `return` /
    // `return null` branches and skip the returnType annotation for
    // those positions. The TS2322 error fires AT the function's own
    // `return undefined` line — same file as the annotation — so the
    // oracle catches it directly without the transitive scan.
    const src =
      "export function transformFilter(f: number | null) {\n" +
      "    if (f === null) return undefined;\n" +
      "    return { id: f };\n" +
      "}\n";
    // Probe: insert `: { id: number }` returnType — the narrow shape
    // ts-capture would observe from a successful call. Function's own
    // `return undefined;` then fails TS2322.
    const paramsClose = src.indexOf(")") + 1;
    const out = applied(
      src,
      [
        entry("target.ts", paramsClose, [["{ id: number }"]], {
          returnType: true,
          fnRetPos: paramsClose,
        }),
      ],
      { verify: true },
    );
    expect(out).toLeaveUntyped({ returnOf: "transformFilter" });
  });

  it("oracle catches a param annotation broader than its satisfies clause", () => {
    // The `satisfiesContextPositions` heuristic (removed)
    // skipped any annotation on functions nested inside a satisfies
    // expression. The motivation: ResourceCallbacks<T>['beforeUpdate']
    // declares `(p: UpdateParams<T>) => …` but ts-capture observed
    // one specific call where the runtime value also carried extra
    // fields, so apply emitted a BROADER param shape that broke the
    // satisfies clause via function param contravariance.
    const src =
      "const cbs = [{\n" +
      "    handle: (params) => params.id,\n" +
      "} satisfies { handle: (p: { id: number }) => unknown }];\n";
    // Probe: insert `: { id: number; tags: number[] }` — broader
    // than the satisfies clause's `{ id: number }`. Function param
    // contravariance: satisfies side's `{ id: number }` not
    // assignable to annotation's `{ id: number; tags: number[] }`.
    // satisfies expression fails type-check at the same file.
    const out = applied(
      src,
      [
        entry(
          "target.ts",
          src.indexOf("params)") + "params".length,
          [["{ id: number; tags: number[] }"]],
          {
            arrow: true,
          },
        ),
      ],
      { verify: true },
    );
    expect(out).toLeaveUntyped("params");
  });

  it("oracle catches a spread RHS narrowing below same-file property access", () => {
    // Previously: `objectLiteralHasMethodProperty` detected spread
    // assignments (`{ ...data }`) and skipped the outer annotation
    // because the captured shape misses fields that arrive via the
    // spread. The downstream TS2339 fires AT a property-access line
    // in the same file — oracle catches it directly.
    const src =
      "declare const data: { tags: number[]; company_id: number };\n" +
      "function f() {\n" +
      "    const newData = { ...data };\n" +
      "    return newData.company_id;\n" +
      "}\n" +
      "f();\n";
    // Probe: annotate `newData` as `: { tags: number[] }`. The spread
    // brings in `company_id` but the narrow annotation drops it —
    // the subsequent `newData.company_id` access fails TS2339.
    const out = applied(
      src,
      [
        entry("target.ts", src.indexOf("newData") + "newData".length, [["{ tags: number[] }"]], {
          varDecl: true,
        }),
      ],
      { verify: true },
    );
    expect(out).toLeaveUntyped("newData");
  });

  it("oracle catches an object literal of useless-arrow methods vs parent interface", () => {
    // Previously: `objectLiteralHasMethodProperty` detected method
    // properties (both arrow-as-PropertyAssignment and shorthand
    // MethodDeclaration) and skipped the outer annotation. The real
    // regression — a structural `(arg: unknown) => unknown` shape
    // breaks contextual typing against a parent interface like
    // `DataProvider` — surfaces at the consumer, caught by the
    // transitive scan.
    const src =
      "interface Provider { create: (resource: string) => Promise<number>; }\n" +
      "export const provider = { create: (resource) => Promise.resolve(1) };\n";
    // Probe: annotate `provider` with the literal shape having
    // `(r: unknown) => unknown` — too broad on params (function
    // param contravariance: `string` not assignable to `unknown`'s
    // contravariant input position when we look at the OTHER
    // direction) and too narrow on return (unknown vs Promise<number>).
    const out = applied(
      src,
      [
        entry(
          "target.ts",
          src.indexOf("provider = ") + "provider".length,
          [["{ create: (resource: unknown) => unknown }"]],
          {
            varDecl: true,
          },
        ),
      ],
      {
        verify: true,
        files: {
          "index.ts": "export * from './target';\n",
          "consumer.ts":
            "import { provider } from './index';\n" +
            "interface Provider { create: (resource: string) => Promise<number>; }\n" +
            "const dp: Provider = provider;\n" +
            "void dp;\n",
        },
      },
    );
    // Oracle rejects via transitive scan — consumer.ts's
    // `const dp: Provider = provider` would fail.
    expect(out).toLeaveUntyped("provider");
  });

  it("steady-state re-apply produces zero verify probes (AST idempotency)", () => {
    // A second apply on already-annotated source must NOT exercise the verify
    // path at all. The CST applier's AST-native idempotency check
    // (`node.type !== undefined`) skips already-typed sites BEFORE they enter
    // the candidate list, so the batch is empty and never probes. Simplest
    // signal: the source comes back unchanged AND the context's
    // `currentSource` still equals the input (no `advanceCurrentSource`
    // either — pass-through is also empty when nothing is left to apply).
    const src = "export function id(a: unknown): unknown { return a; }\n";
    const out = applied(
      src,
      [
        entry("target.ts", src.indexOf("a:") + 1, [["unknown"]]),
        entry("target.ts", src.indexOf(")") + 1, [["unknown"]], { returnType: true }),
      ],
      { verify: true },
    );
    expect(out.text).toBe(src);
    expect(out.verify?.currentSource).toBe(src);
  });

  it("does not mutate verify context when all candidates are rejected", () => {
    const src = "const x = 1;\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("x") + 1, [["string"]], { varDecl: true })],
      {
        verify: true,
      },
    );
    expect(out.verify?.currentSource).toBe(src);
  });

  // `skipRedundantAnnotations` reads as a redundancy switch, and its
  // documentation says nothing more. It used to gate the whole checker, so
  // turning it off also turned off every guard against a destructive write —
  // including this one, which refuses a type *narrower* than the inferred one.
  // That direction does not remove an error, it introduces one.
  it("refuses a narrowing annotation even with the redundancy flag off", () => {
    const src =
      "declare const k: string | symbol;\n" +
      "export function f() {\n" +
      "  const key = k;\n" +
      "  return key;\n" +
      "}\n";
    const typeInfo = [
      entry("target.ts", src.indexOf("const key") + "const key".length, [["string"]], {
        varDecl: true,
      }),
    ];
    for (const applier of ["cst", "offset"] as const) {
      const out = applied(src, typeInfo, {
        project: true,
        applier,
        infer: { ...INFER_DEFAULTS, skipRedundantAnnotations: false },
      });
      expect(out).toLeaveUntyped("key");
    }
  });

  it("writes observed literals as the imported alias that unites them", () => {
    const src =
      'import type { Status } from "./status.js";\n' +
      "export function isActive(status) {\n" +
      '  return status === "active";\n' +
      "}\n" +
      "export const seen: Status[] = [];\n";
    const out = applied(
      src,
      [entry("target.ts", src.indexOf("(status)") + 7, [['"active"'], ['"inactive"']])],
      {
        project: true,
        files: { "status.ts": 'export type Status = "active" | "inactive";\n' },
        infer: { ...INFER_DEFAULTS, literal: { ...INFER_DEFAULTS.literal, string: true } },
      },
    );
    expect(out).toAnnotate("status", { ref: "Status" });
    expect(out).toTypeAs("status", '"active" | "inactive"');
  });

  it("writes an observed tuple as a tuple", () => {
    const src = "export function toPair(key, value) {\n  return [key, value];\n}\n";
    const out = applied(
      src,
      [entry("t.ts", src.indexOf("value)") + 6, [["[string, number]"]], { returnType: true })],
      {
        filename: "t.ts",
      },
    );
    expect(out).toAnnotate({ returnOf: "toPair" }, "[string, number]");
  });

  // Redundancy used to be judged against the program as it stood before apply:
  // a local initialised from a call to an untyped function inferred `any`, the
  // gate bailed, and the local got an annotation TypeScript would infer as soon
  // as the callee had the signature the same run was writing. Signatures go
  // first; locals and callbacks are judged against the file as it then reads.
  describe("redundancy is judged against the file as apply leaves it", () => {
    const idSource = "function id(a) {\n  return a;\n}\nexport const p = id(3);\n";
    const idEntries = (s: string, t = "target.ts"): CollectedTypeInfo => [
      entry(t, s.indexOf("(a)") + 2, [["number"]]),
      entry(t, s.indexOf("(a)") + 3, [["number"]], { returnType: true }),
      entry(t, s.indexOf("const p") + 7, [["number"]], { varDecl: true }),
    ];

    it("drops a local whose callee gets its signature in the same run", () => {
      const out = applied(idSource, idEntries(idSource), { verify: true });
      expect(out).toAnnotate("a", "number");
      expect(out).toAnnotate({ returnOf: "id" }, "number");
      expect(out).toLeaveUntyped("p");
      expect(out).toTypeAs("p", "number");
    });

    it("drops callback parameters and return once the outer parameter types them", () => {
      const src =
        "export function sum(values) {\n  return values.reduce((total, value) => total + value, 0);\n}\n";
      const entries = (s: string, t = "target.ts"): CollectedTypeInfo => [
        entry(t, s.indexOf("(values)") + 7, [["number[]"]]),
        entry(t, s.indexOf("(values)") + 8, [["number"]], { returnType: true }),
        entry(t, s.indexOf("(total") + 6, [["number"]]),
        entry(t, s.indexOf(" value)") + 6, [["number"]]),
        entry(t, s.indexOf(" value)") + 7, [["number"]], { returnType: true }),
      ];
      const out = applied(src, entries(src), { verify: true });
      expect(out).toAnnotate("values", "number[]");
      expect(out).toAnnotate({ returnOf: "sum" }, "number");
      for (const callbackParam of ["total", "value"]) {
        expect(out).toLeaveUntyped(callbackParam);
        expect(out).toTypeAs(callbackParam, "number");
      }
      expect(nodesOf(out, ts.isArrowFunction)[0].type).toBeUndefined();
    });

    // The first pass moves everything after its insertions, the file's own
    // errors included. The second pass judged against the errors' old places
    // and took every moved one for a new one.
    it("still writes a local when the first pass moved an error the file already had", () => {
      const src =
        "export function id(a) {\n  return a;\n}\n" +
        'export const p = JSON.parse("{}");\n' +
        'export const bad: number = "x";\n';
      const entries = (s: string, t = "target.ts"): CollectedTypeInfo => [
        entry(t, s.indexOf("(a)") + 2, [["number"]]),
        entry(t, s.indexOf("const p") + 7, [["{ x: number, y: number }"]], { varDecl: true }),
      ];
      const out = applied(src, entries(src), { verify: true });
      expect(out).toAnnotate("p", "{ x: number; y: number }");
      expect(out).toHaveNoNewDiagnostics();
    });

    it("reports the dropped local at its position in the original source", () => {
      const telemetry = newApplyTelemetry();
      applied(idSource, idEntries(idSource), { verify: true, telemetry });
      expect(telemetry.redundant).toBe(1);
      expect(telemetry.skipped).toContainEqual(
        expect.objectContaining({ pos: idSource.indexOf("const p") + 7, reason: "redundant" }),
      );
    });
  });

  // --- notes: text is the claim --------------------------------------------
  //
  // A note is a comment, and where it lands and what it says is the point of
  // the test. These assert the text of the output on purpose.

  // A line start inside a multi-line template is inside the *string*. Writing
  // a note there makes it text, and its backticks close the template early.
  // Found by looking at applied output, not by a test — nest has no
  // annotation site inside a template literal.
  it("writes no note where the line start is inside a template literal", () => {
    const src = "const items = [{ id: 1 }];\nconst s = `\n  ${items.map(x => x.id)}\n`;\n";
    const out = applied(src, [entry("t.ts", src.indexOf("x =>") + 1, [["number"]])], {
      infer: { ...INFER_DEFAULTS, outputMode: "both" },
      filename: "t.ts",
    });
    expect(out.text).not.toContain("@ts-capture");
    // The annotation itself is unaffected — it goes inside the interpolation,
    // which is code.
    expect(out).toAnnotate("x", "number");
  });

  // The dialect matters: parsing a `.ts` file as TSX reads `<` as a JSX tag,
  // and the misparse invents JsxText over ordinary code. That refused a real
  // note on nest — `const currentRoutingKey = routingKeySegments[i];`, which
  // is not inside anything.
  it("writes a note in a .ts file that uses angle brackets", () => {
    const src = "const parts = collect<string>(input);\nconst first = parts[0];\n";
    const out = applied(
      src,
      [
        entry("t.ts", src.indexOf("const first") + "const first".length, [["string"]], {
          varDecl: true,
        }),
      ],
      { infer: { ...INFER_DEFAULTS, outputMode: "comments" }, filename: "t.ts" },
    );
    expect(out.text).toContain("// @ts-capture[proposal]: `first` would be `string`");
  });

  // The checker's view is held in one variable shared by every branch, and the
  // `this` branch never sets it — so its preview reported whatever the previous
  // entry had asked about. Here that is `v`, a binding in another function two
  // lines up. A note that names the wrong position is worse than no note.
  it("does not let a preview claim a type from another site", () => {
    const src =
      "declare const n: number;\n" +
      "export function g() {\n" +
      "  const v = n;\n" +
      "  return v;\n" +
      "}\n" +
      "export function needsThis(x) {\n" +
      "  return x;\n" +
      "}\n";
    const out = applied(
      src,
      [
        entry("target.ts", src.indexOf("const v") + "const v".length, [["number"]], {
          varDecl: true,
        }),
        entry("target.ts", src.indexOf("needsThis(") + "needsThis(".length, [["string"]], {
          thisType: true,
        }),
      ],
      { project: true, infer: { ...INFER_DEFAULTS, outputMode: "comments" } },
    );
    expect(out.text).toContain("`this` would be `string`");
    expect(out.text).not.toContain("TypeScript infers `number`");
  });

  const UNPLACEABLE =
    "export function f(): string {\n" +
    "  return 'x';\n" +
    "}\n" +
    "export const t = `\n" +
    "head ${(() => { const p = f(); return p; })()} tail\n" +
    "`;\n";
  const contradictedP = (src: string) =>
    entry("target.ts", src.indexOf("const p") + "const p".length, [["string|undefined"]], {
      varDecl: true,
    });

  // A note cannot be written on a line whose start is inside template text —
  // the comment would become part of the string. The contradiction is still
  // real, so the annotation is still refused: apply reports rather than fixes,
  // and a contradiction it cannot report is not a licence to write.
  it.each(["cst", "offset"] as const)(
    "writes neither note nor annotation when the note cannot be placed (%s)",
    (applier) => {
      const out = applied(UNPLACEABLE, [contradictedP(UNPLACEABLE)], { project: true, applier });
      expect(out.text).toBe(UNPLACEABLE);
    },
  );

  // Regression: the offset applier used `break` where it meant "skip this
  // site", so one unplaceable note abandoned the entry loop and every later
  // annotation in the file was lost silently.
  it.each(["cst", "offset"] as const)(
    "keeps annotating later sites after a note it could not place (%s)",
    (applier) => {
      const src = UNPLACEABLE + "export function later(a) {\n  return a;\n}\n";
      const out = applied(
        src,
        [
          contradictedP(src),
          entry("target.ts", src.indexOf("later(a)") + "later(a".length, [["number"]]),
        ],
        { project: true, applier },
      );
      expect(out).toAnnotate("a", "number");
    },
  );

  // Both appliers place notes by one rule, and that rule lives in
  // `noteReplacements` — the only place that knows whether a line is crowded
  // and the note therefore goes at the site rather than above it. An early
  // check in one applier answered the leading-line question for notes that
  // never became leading lines, and dropped them.
  it.each(["cst", "offset"] as const)(
    "places the same notes from either applier on a crowded line inside a template (%s)",
    (applier) => {
      const src = "const t = `\nhead ${[1].map((a) => [2].map((b) => a + b))} tail\n`;\n";
      const out = applied(
        src,
        [
          entry("t.ts", src.indexOf("(a)") + 2, [["number"]]),
          entry("t.ts", src.indexOf("(b)") + 2, [["number"]]),
        ],
        { filename: "t.ts", applier, infer: { ...INFER_DEFAULTS, outputMode: "comments" } },
      );
      expect(out.text.match(/@ts-capture/g) ?? []).toHaveLength(2);
    },
  );

  // `this` has no single value to write down — the same loss the return-type
  // rule above refuses, arriving through a contextually typed parameter. The
  // offset applier already refused it; the CST applier, which is the default,
  // did not.
  it.each(["cst", "offset"] as const)(
    "never annotates a param the checker infers as `this` (%s)",
    (applier) => {
      const src =
        "export class Box {\n" +
        "  each(fn: (self: this) => void) {\n" +
        "    fn(this);\n" +
        "  }\n" +
        "  go() {\n" +
        "    this.each((s) => s.go());\n" +
        "  }\n" +
        "}\n";
      const out = applied(
        src,
        [entry("target.ts", src.indexOf("((s)") + "((s".length, [["Box"]], { arrow: true })],
        {
          project: true,
          applier,
        },
      );
      expect(out).toLeaveUntyped("s");
    },
  );

  // A builder that returns `this` keeps working in a subclass. The run only
  // ever sees the concrete instance, so ts-capture writes the class name and
  // every subclass caller gets the base class back. Eight nest methods, all
  // builders, were annotated that way.
  it.each(["cst", "offset"] as const)(
    "never annotates a return type the checker infers as `this` (%s)",
    (applier) => {
      const src =
        "export class Builder {\n" +
        "  addValidator() {\n" +
        "    return this;\n" +
        "  }\n" +
        "}\n";
      const paramsClose = src.indexOf("addValidator()") + "addValidator()".length;
      const out = applied(
        src,
        [
          entry("target.ts", paramsClose, [["Builder"]], {
            returnType: true,
            fnRetPos: paramsClose,
          }),
        ],
        { project: true, applier },
      );
      expect(out).toLeaveUntyped({ returnOf: "addValidator" });
    },
  );

  const CONTRADICTED =
    "export function f(): string {\n" +
    "  return 'x';\n" +
    "}\n" +
    "export function g() {\n" +
    "  const p = f();\n" +
    "  return p;\n" +
    "}\n";

  // The run saw a value the position's own type says cannot occur. Apply
  // reports it and leaves the code alone: whether the right fix is to widen the
  // type or to stop producing `undefined` is not something an observation can
  // decide. Driven directly, the offset applier has to reach the same answer.
  it.each(["cst", "offset"] as const)(
    "writes a note instead of an annotation when the run contradicts the checker (%s)",
    (applier) => {
      const out = applied(CONTRADICTED, [contradictedP(CONTRADICTED)], { project: true, applier });
      expect(out.text).toContain(
        "  // @ts-capture[conflict]: `p` observed `undefined`, TypeScript infers `string`\n  const p = f();",
      );
      expect(out).toLeaveUntyped("p");
    },
  );

  // The CST applier hands its pass-through entries to the offset applier along
  // with the source it has already rewritten — notes included. If the second
  // pass stripped as well, it would delete what the first one just wrote.
  it("does not strip the notes the CST pass just wrote", () => {
    const out = applied(
      CONTRADICTED,
      [
        contradictedP(CONTRADICTED),
        // A pass-through entry: no CST site owns this offset, so it is handed to
        // the offset applier in a second pass.
        entry("target.ts", 1, [["string"]], {}),
      ],
      { project: true },
    );
    expect(out.text).toContain("// @ts-capture[conflict]: `p` observed `undefined`");
  });

  describe("outputMode", () => {
    const SEEN_TWICE = "export function f(x) {\n  return x.length;\n}\nf('a');\nf('b');\n";
    const seenTwice = (src: string): CollectedTypeInfo => {
      const seen: [string] = ["string"];
      return [entry("target.ts", src.indexOf("(x)") + 2, [seen, seen])];
    };
    const inMode = (outputMode: "annotations" | "comments" | "both") =>
      applied(SEEN_TWICE, seenTwice(SEEN_TWICE), {
        project: true,
        infer: { ...INFER_DEFAULTS, outputMode },
      });

    it("annotations: writes the type and no note", () => {
      const out = inMode("annotations");
      expect(out).toAnnotate("x", "string");
      expect(out.text).not.toContain("@ts-capture");
    });

    it("comments: writes the note and leaves the code alone", () => {
      const out = inMode("comments");
      expect(out.text).toContain("// @ts-capture[proposal]: `x` would be `string`");
      expect(out.text).toContain("// @ts-capture:   observed 2 times; TypeScript infers `any`");
      expect(out).toLeaveUntyped("x");
    });

    // Beside the annotation the note drops the type: it is on the next line
    // already, and "would write" would claim something did not happen when it
    // did. What is left is what the annotation cannot say.
    it("both: writes the type, and a note saying only what the type cannot", () => {
      const out = inMode("both");
      expect(out.text).toContain(
        "// @ts-capture[applied]: `x` observed 2 times; TypeScript infers `any`",
      );
      expect(out.text).not.toContain("would write");
      expect(out).toAnnotate("x", "string");
    });

    const BOTH = { infer: { ...INFER_DEFAULTS, outputMode: "both" as const }, filename: "t.ts" };

    // One line, several sites: a leading note has to name its position, and in
    // `const a = (d) => (d) => (d) => null;` there is one name for four of
    // them. At the site the position is the identifier and the question does
    // not arise.
    it("puts the notes at the sites when a line holds several", () => {
      const src = "const make = (s) => (d) => (e) => e;\n";
      const out = applied(
        src,
        [
          entry("t.ts", src.indexOf("(s)") + 2, [["string"]]),
          entry("t.ts", src.indexOf("(d)") + 2, [["number"]]),
        ],
        BOTH,
      );
      expect(out.text).toBe(
        "const make = (s: string /* @ts-capture[applied]: observed once */) => " +
          "(d: number /* @ts-capture[applied]: observed once */) => (e) => e;\n",
      );
    });

    it("keeps the leading note when the line holds one site", () => {
      const src = "const a = 1;\nconst b = f();\n";
      const out = applied(
        src,
        [entry("t.ts", src.indexOf("const b") + "const b".length, [["string"]], { varDecl: true })],
        BOTH,
      );
      expect(out.text).toContain(
        "// @ts-capture[applied]: `b` observed once\nconst b: string = f();",
      );
    });

    // Rewriting a line and annotating it inline happen at the same positions,
    // and the ordering is not obvious: a paren-less arrow also inserts `(` and
    // `)` around the parameter. These pin the combinations, and each asserts
    // the result still parses — a misplaced insertion corrupts syntax rather
    // than merely reading badly.
    it("wraps a paren-less arrow, annotates it, and notes it, twice on one line", () => {
      const src = "const h = a.map(x => x.id).filter(y => y);\n";
      const xAt = src.indexOf("x =>");
      const yAt = src.indexOf("y =>");
      const out = applied(
        src,
        [
          entry("t.ts", xAt + 1, [["string"]], { parens: [xAt, xAt + 1] }),
          entry("t.ts", yAt + 1, [["boolean"]], { parens: [yAt, yAt + 1] }),
        ],
        BOTH,
      );
      // The note lands outside the closing paren, where the annotation ends.
      expect(out.text).toBe(
        "const h = a.map((x: string) /* @ts-capture[applied]: observed once */ => x.id)" +
          ".filter((y: boolean) /* @ts-capture[applied]: observed once */ => y);\n",
      );
      expect(parseErrors(out)).toEqual([]);
    });

    it("annotates a parameter and a return type on one line, noting both", () => {
      const src = "const k = (a) => a.length;\n";
      const at = src.indexOf("(a)");
      const out = applied(
        src,
        [
          entry("t.ts", at + 2, [["string"]]),
          entry("t.ts", at + 3, [["number"]], { returnType: true, fnRetPos: at + 3 }),
        ],
        BOTH,
      );
      expect(out.text).toBe(
        "const k = (a: string /* @ts-capture[applied]: observed once */)" +
          ": number /* @ts-capture[applied]: observed once */ => a.length;\n",
      );
      expect(parseErrors(out)).toEqual([]);
    });

    // Strip and write in one pass, against the original source, so the two
    // cannot shift each other's offsets.
    it("removes last run's inline notes while writing this run's", () => {
      const src =
        "const h = a.map((x: string) /* @ts-capture[applied]: observed once */ => x.id)" +
        ".filter((y: boolean) /* @ts-capture[applied]: observed once */ => y);\n";
      const out = applied(src, [], BOTH);
      expect(out.text).toBe("const h = a.map((x: string) => x.id).filter((y: boolean) => y);\n");
      expect(parseErrors(out)).toEqual([]);
    });

    // A line is crowded by the notes that survive, not by the candidates that
    // start out. Both declarations here are on one line and both are
    // candidates, but `a: string` cannot annotate `1`, so verify drops it — and
    // the one note left belongs above the line, not inside it.
    it("puts the survivor above the line when verify rejects its neighbour", () => {
      const src = 'const a = 1, b = JSON.parse("2");\nexport { a, b };\n';
      const out = applied(
        src,
        [
          entry("target.ts", src.indexOf("a =") + 1, [["string"]], { varDecl: true }),
          entry("target.ts", src.indexOf("b =") + 1, [["number"]], { varDecl: true }),
        ],
        { verify: true, infer: { ...INFER_DEFAULTS, outputMode: "both" } },
      );
      expect(out).toLeaveUntyped("a");
      expect(out).toAnnotate("b", "number");
      expect(out.text).not.toContain("/* @ts-capture");
      expect(out.text).toContain(
        "// @ts-capture[applied]: `b` observed once; TypeScript infers `any`\n" +
          'const a = 1, b: number = JSON.parse("2");',
      );
      expect(parseErrors(out)).toEqual([]);
    });

    // Conflict notes are notes too. They were left out of the crowding rule,
    // which put two formats on one line — and left them with the naming
    // collision the previews had fixed: two `d`s in a chain, two notes both
    // saying `d`.
    // `secondType` decides whether the inner `d` contradicts or gets annotated:
    // against `any` there is nothing to contradict.
    const chain = (secondType: string) => {
      const src =
        `declare function run(f: (d: string) => (d: ${secondType}) => unknown): void;\n` +
        "run(d => d => d);\n";
      const first = src.indexOf("d =>") + 1;
      const second = src.indexOf("d =>", first) + 1;
      return { src, first, second };
    };

    it("puts two conflicts at their sites rather than above the line", () => {
      const { src, first, second } = chain("number");
      const out = applied(
        src,
        [
          entry("target.ts", first, [["undefined"], ["string"]], { parens: [first - 1, first] }),
          entry("target.ts", second, [["undefined"], ["number"]], { parens: [second - 1, second] }),
        ],
        { project: true },
      );
      expect(out.text).toContain(
        "run(d /* @ts-capture[conflict]: observed `undefined`, TypeScript infers `string` */ " +
          "=> d /* @ts-capture[conflict]: observed `undefined`, TypeScript infers `number` */ => d);",
      );
      expect(parseErrors(out)).toEqual([]);
    });

    it("uses one format when a conflict and an annotation share a line", () => {
      const { src, first, second } = chain("any");
      const out = applied(
        src,
        [
          entry("target.ts", first, [["undefined"], ["string"]], { parens: [first - 1, first] }),
          entry("target.ts", second, [["number"]], { parens: [second - 1, second] }),
        ],
        { project: true, infer: { ...INFER_DEFAULTS, outputMode: "both" } },
      );
      expect(out.text).not.toContain("// @ts-capture");
      expect(out.text).toContain("[conflict]: observed `undefined`");
      expect(out.text).toContain("[applied]: observed once");
      expect(parseErrors(out)).toEqual([]);
    });

    it("keeps a lone conflict above the line", () => {
      const { src, first } = chain("any");
      const out = applied(
        src,
        [entry("target.ts", first, [["undefined"], ["string"]], { parens: [first - 1, first] })],
        { project: true },
      );
      expect(out.text).toContain(
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
      const out = applied(
        src,
        [
          entry("t.ts", at + 2, [["string"]]),
          entry("t.ts", at + 3, [["number"]], { returnType: true, fnRetPos: at + 3 }),
        ],
        { ...BOTH, applier: "offset" },
      );
      expect(out.text).toBe(
        "const k = (a: string /* @ts-capture[applied]: observed once */)" +
          ": number /* @ts-capture[applied]: observed once */ => a.length;\n",
      );
      expect(parseErrors(out)).toEqual([]);
    });

    it("the offset applier keeps a lone note above the line", () => {
      const src = "const a = 1;\nconst b = f();\n";
      const out = applied(
        src,
        [entry("t.ts", src.indexOf("const b") + "const b".length, [["string"]], { varDecl: true })],
        { ...BOTH, applier: "offset" },
      );
      expect(out.text).toContain(
        "// @ts-capture[applied]: `b` observed once\nconst b: string = f();",
      );
    });

    // A preview that names an annotation apply would not actually write is not
    // a preview. The first run on nest wrote 261 of them against 125 real
    // annotations — the difference being exactly the candidates the batch
    // verify pass rejects.
    it("does not preview an annotation verify would reject", () => {
      // `const x = 1` cannot be a `string`; verify rejects it.
      const src = "const x = 1;\n";
      const out = applied(
        src,
        [entry("target.ts", src.indexOf("x") + 1, [["string"]], { varDecl: true })],
        {
          verify: true,
          infer: { ...INFER_DEFAULTS, outputMode: "comments" },
        },
      );
      expect(out.text).toBe(src);
    });

    // The preview is scaffolding: an ordinary apply owns every line carrying
    // the marker, so the next run cleans up after the review.
    it("an ordinary apply removes a preview left behind", () => {
      const previewed = inMode("comments");
      expect(previewed.text).toContain("@ts-capture");
      // Second pass over the previewed text, in the default mode. The offsets
      // the entries carry are into the original source, so this asserts only
      // that the notes are gone.
      const cleaned = applied(previewed.text, [], { project: true });
      expect(cleaned.text).not.toContain("@ts-capture");
    });
  });

  it("removes a note whose conflict is gone", () => {
    const src =
      "export function f(): string {\n" +
      "  return 'x';\n" +
      "}\n" +
      "export function g() {\n" +
      "  // @ts-capture: `p` observed `undefined`, TypeScript infers `string`\n" +
      "  const p = f();\n" +
      "  return p;\n" +
      "}\n";
    // No entry contradicts anything this time.
    const out = applied(src, [], { project: true });
    expect(out.text).not.toContain("@ts-capture");
    expect(out).toLeaveUntyped("p");
  });

  // Found by the eval, not by the tests above: nest aliases `this` into a local
  // (`const self: Module = this`) so a class expression can close over it. The
  // checker types that binding `this` too, and writing the class name there
  // erases exactly what it erases on a return type.
  it.each(["cst", "offset"] as const)(
    "never annotates a binding the checker infers as `this` (%s)",
    (applier) => {
      const src =
        "export class Module {\n" +
        "  make() {\n" +
        "    const self = this;\n" +
        "    return self;\n" +
        "  }\n" +
        "}\n";
      const out = applied(
        src,
        [
          entry("target.ts", src.indexOf("const self") + "const self".length, [["Module"]], {
            varDecl: true,
          }),
        ],
        { project: true, applier },
      );
      expect(out).toLeaveUntyped("self");
    },
  );

  // Control: same shape, same class name written, but the body does not return
  // `this` — so the guard must not fire and the annotation must land. Without
  // this the test above would pass just as well if the applier stopped
  // annotating return types altogether.
  it("still annotates a class-typed return the checker cannot infer", () => {
    const src = "export class Builder {\n" + "  make(f) {\n" + "    return f;\n" + "  }\n" + "}\n";
    const paramsClose = src.indexOf("make(f)") + "make(f)".length;
    const out = applied(
      src,
      [entry("target.ts", paramsClose, [["Builder"]], { returnType: true, fnRetPos: paramsClose })],
      { project: true },
    );
    expect(out).toAnnotate({ returnOf: "make" }, { ref: "Builder" });
  });

  describe("infer.aliasRepeatedShapes with the type-check oracle", () => {
    it("verifies the annotations with the declaration they name", () => {
      const src =
        "export function a(product) { return product.sku; }\n" +
        "export function b(item) { return item.price; }\n";
      const out = applied(src, twoParams("target.ts", src), { verify: true, ...ALIAS });
      expect(out).toDeclareAlias("Product", PRODUCT);
      expect(out).toAnnotate("product", { ref: "Product" });
      expect(out).toAnnotate("item", { ref: "Product" });
      expect(out).toHaveNoNewDiagnostics();
    });

    it("declares nothing when no annotation naming it is written", () => {
      const src =
        "export function a(product) { return product.weight; }\n" +
        "export function b(item) { return item.weight; }\n";
      const out = applied(src, twoParams("target.ts", src), { verify: true, ...ALIAS });
      expect(out).toLeaveUntyped("product");
      expect(out).toLeaveUntyped("item");
      expect(aliasesDeclared(out)).toEqual([]);
    });

    it("names a local after a type the same run declared for the file's signatures", () => {
      const src =
        "export function a(product) { return product.sku; }\n" +
        "export function b(item) { return item.price; }\n" +
        'export const parsed = JSON.parse("{}");\n';
      const entries = (s: string, t = "target.ts"): CollectedTypeInfo => [
        ...twoParams(t, s),
        entry(t, s.indexOf("parsed") + 6, [[PRODUCT]], { varDecl: true }),
      ];
      const out = applied(src, entries(src), { verify: true, ...ALIAS });
      expect(out).toAnnotate("parsed", { ref: "Product" });
      expect(out).toTypeAs("parsed", PRODUCT);
      expect(aliasesDeclared(out)).toEqual(["Product"]);
    });
  });
});

describe("applyTypesToFileCst — infer.ignoreExistingTypes", () => {
  // Divergence-measurement mode: bypass the AST-native idempotency checks
  // (`!node.type` filter on params, `hasType` skip on varDecls,
  // `hasReturnType` skip on return types). The new annotation is emitted
  // even at already-typed positions; output is intentionally broken TS
  // but the emitted annotations are grep-able, so the text is the claim.
  const MEASURE = {
    infer: { ...INFER_DEFAULTS, requireTypeRefInScope: false, ignoreExistingTypes: true },
  };

  it("default behaviour: typed param is NOT indexed (existing CST contract)", () => {
    const source = "function foo(a: string) {}";
    expect(applied(source, [entry("test.ts", 14, [["number"]])]).text).toBe(source);
  });

  it("flag on: typed param IS re-annotated despite existing annotation", () => {
    const source = "function foo(a: string) {}";
    const out = applied(source, [entry("test.ts", 14, [["number"]])], MEASURE);
    expect(out.text).toBe("function foo(a: number: string) {}");
  });

  it("flag on: typed varDecl IS re-annotated", () => {
    const source = "const x: number = 1;";
    // pos = end of "x" (after the identifier name)
    const out = applied(source, [entry("test.ts", 7, [["string"]], { varDecl: true })], MEASURE);
    expect(out.text).toBe("const x: string: number = 1;");
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
  const ASSERTED: Array<[string, string]> = [
    ['const M = { a: "guard" } as const;', "{ a: string }"],
    ['const M = ["a", "b"] as const satisfies string[];', "string[]"],
    ['const M = { [K]: "guard" } as const;', "{ __guards__: string }"],
  ];
  for (const applier of ["cst", "offset"] as const) {
    it.each(ASSERTED)(`leaves %s alone (${applier})`, (source, emitted) => {
      const pos = source.indexOf("M") + 1;
      const out = applied(source, [entry("test.ts", pos, [[emitted]], { varDecl: true })], {
        ...KEEP_INFERABLE,
        applier,
      });
      expect(out).toLeaveUntyped("M");
    });
  }

  // `unique symbol` is the same narrowing, inferred rather than asked for.
  // Writing `: symbol` widens it away and every `x === THE_SYMBOL` narrowing
  // downstream stops working — one annotation on nestjs/nest's
  // `VERSION_NEUTRAL` produced three compile errors in files that never
  // mention it. Destruction, not restatement, so it does not wait for the flag.
  for (const applier of ["cst", "offset"] as const) {
    it.each([["const sym = Symbol('x');"], ["const sym = Symbol.for('x');"]])(
      `leaves %s alone even with the flag off (${applier})`,
      (source) => {
        const pos = source.indexOf("sym") + 3;
        const out = applied(source, [entry("test.ts", pos, [["symbol"]], { varDecl: true })], {
          ...KEEP_INFERABLE,
          applier,
        });
        expect(out).toLeaveUntyped("sym");
      },
    );
  }

  // The guard is syntactic, like the rest of this module: a bare `Symbol`
  // identifier and nothing else. This one is the control — if it stops being
  // annotated, the guard has grown teeth it was not given.
  it("still annotates a call that only looks like Symbol", () => {
    const source = "const sym = ns.Symbol('x');";
    const pos = source.indexOf("sym") + 3;
    const out = applied(
      source,
      [entry("test.ts", pos, [["symbol"]], { varDecl: true })],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("sym", "symbol");
  });

  it("still annotates an initializer without the assertion", () => {
    const source = 'const M = { [K]: "guard" };';
    const out = applied(
      source,
      [entry("test.ts", source.indexOf("M") + 1, [["{ __guards__: string }"]], { varDecl: true })],
      KEEP_INFERABLE,
    );
    expect(out).toAnnotate("M", "{ __guards__: string }");
  });
});

// A parameter's observed shape is the caller's object, and in a test run the
// caller is a fixture. The body says which properties the function actually
// needs; with `narrowParamShapes` on, the annotation says no more than that.
describe("infer.narrowParamShapes", () => {
  const PRODUCT = "{ name: string, price: number, sku: string, tags: string[], weight: number }";
  const source =
    "export function addLine(cart, product, quantity) {\n" +
    "  cart.lines.push({ sku: product.sku, quantity, unitPrice: product.price });\n" +
    "  return cart;\n" +
    "}\n";
  const entries = (file: string, src = source): CollectedTypeInfo => [
    entry(file, src.indexOf("cart,") + 4, [["{ lines: { sku: string }[] }"]]),
    entry(file, src.indexOf("product,") + 7, [[PRODUCT]]),
  ];
  const NARROW = { infer: { ...INFER_DEFAULTS, narrowParamShapes: true } };

  it("is off by default and writes the shape the run observed", () => {
    expect(applied(source, entries("test.ts"))).toAnnotate("product", PRODUCT);
  });

  it("writes only the properties the body reads, and the whole shape where it escapes", () => {
    const out = applied(source, entries("test.ts"), NARROW);
    expect(out).toAnnotate("product", "{ price: number; sku: string }");
    expect(out).toAnnotate("cart", "{ lines: { sku: string }[] }");
    expect(out).toLeaveUntyped("quantity");
  });

  // The contract beats the fixture: a named type the whole shape matches is
  // what the parameter is, and narrowing it would hide that.
  it("prefers an in-scope type the whole shape matches over narrowing", () => {
    const withInterface =
      "interface Product { name: string; price: number; sku: string; tags: string[]; weight: number }\n" +
      source;
    const out = applied(withInterface, entries("test.ts", withInterface), NARROW);
    expect(out).toAnnotate("product", { ref: "Product" });
    expect(out).toTypeAs("product", PRODUCT);
  });

  it("writes the narrowed shape as an in-scope type it matches exactly", () => {
    const withAlias = "type Priced = { price: number; sku: string };\n" + source;
    const out = applied(withAlias, entries("test.ts", withAlias), NARROW);
    expect(out).toAnnotate("product", { ref: "Priced" });
    expect(out).toTypeAs("product", "{ price: number; sku: string }");
  });
});

// A shape the run saw at several positions in one file is one type, and
// writing it out at each of them says so nowhere. With `aliasRepeatedShapes`
// on, apply declares it once, named after the first position that holds it.
const PRODUCT = "{ price: number, sku: string }";
const ALIAS = { infer: { ...INFER_DEFAULTS, aliasRepeatedShapes: true } };
const twoParams = (file: string, src: string): CollectedTypeInfo => [
  entry(file, src.indexOf("(product)") + 8, [[PRODUCT]]),
  entry(file, src.indexOf("(item)") + 5, [[PRODUCT]]),
];

describe("infer.aliasRepeatedShapes", () => {
  const source =
    'import { x } from "./x";\n\n' +
    "export function a(product) { return x(product); }\n" +
    "export function b(item) { return x(item); }\n";
  it("is off by default and writes the shape at each site", () => {
    const out = applied(source, twoParams("test.ts", source));
    expect(out).toAnnotate("product", PRODUCT);
    expect(out).toAnnotate("item", PRODUCT);
    expect(aliasesDeclared(out)).toEqual([]);
  });

  it("declares the shape once after the imports and names it at each site", () => {
    const out = applied(source, twoParams("test.ts", source), ALIAS);
    expect(out).toDeclareAlias("Product", PRODUCT);
    expect(out).toAnnotate("product", { ref: "Product" });
    expect(out).toAnnotate("item", { ref: "Product" });
    expect(out.sf.statements.findIndex(ts.isTypeAliasDeclaration)).toBe(1);
  });

  it("declares the shape at the top of a file without imports", () => {
    const src = source.slice(source.indexOf("export"));
    const out = applied(src, twoParams("test.ts", src), ALIAS);
    expect(out).toDeclareAlias("Product", PRODUCT);
    expect(out.sf.statements.findIndex(ts.isTypeAliasDeclaration)).toBe(0);
  });

  it("takes the next site's name when the file already uses the first", () => {
    const src = "class Product {}\n" + source;
    const out = applied(src, twoParams("test.ts", src), ALIAS);
    expect(out).toDeclareAlias("Item", PRODUCT);
    expect(out).toAnnotate("product", { ref: "Item" });
  });

  it("writes an in-scope type the shape matches rather than declaring its own", () => {
    const src = "interface Product { price: number; sku: string }\n" + source;
    const out = applied(src, twoParams("test.ts", src), ALIAS);
    expect(aliasesDeclared(out)).toEqual([]);
    expect(out).toAnnotate("product", { ref: "Product" });
    expect(out).toAnnotate("item", { ref: "Product" });
  });
});
