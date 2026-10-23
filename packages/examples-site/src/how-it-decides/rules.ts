import type { ApplyRule } from "@ts-capture/core/browser";

/** Where in `packages/core/src` each rule is decided. */
export const DECIDED_BY: Record<ApplyRule, { file: string; symbol: string }> = {
  "syntax.ignored": { file: "cst-site-index.ts", symbol: "buildCstSiteIndex" },
  "syntax.already-typed": { file: "cst-routing.ts", symbol: "routeEntries" },
  "syntax.no-site": { file: "cst-routing.ts", symbol: "routeEntries" },
  "syntax.outer-conflict": {
    file: "annotation-eligibility.ts",
    symbol: "decideVarDeclSite",
  },
  "syntax.one-branch-seen": {
    file: "annotation-eligibility.ts",
    symbol: "decideVarDeclSite",
  },
  "syntax.only-undefined-seen": {
    file: "annotation-eligibility.ts",
    symbol: "decideVarDeclSite",
  },
  "syntax.as-cast": {
    file: "cst-replacements.ts",
    symbol: "buildCstReplacements",
  },
  "syntax.as-const": {
    file: "initializer-inference.ts",
    symbol: "hasConstAssertion",
  },
  "syntax.unique-symbol": {
    file: "initializer-inference.ts",
    symbol: "isSymbolCall",
  },
  "syntax.array-callback-shape": {
    file: "annotation-eligibility.ts",
    symbol: "suppressArrayCallbackStructural",
  },
  "syntax.redundant-initializer": {
    file: "initializer-inference.ts",
    symbol: "inferTypeFromInitializer",
  },
  "info.never-passed": {
    file: "cst-replacements.ts",
    symbol: "buildCstReplacements",
  },
  "info.nothing-left": {
    file: "compute-annotation.ts",
    symbol: "computeAnnotation",
  },
  "info.too-long": {
    file: "compute-annotation.ts",
    symbol: "computeAnnotation",
  },
  "info.unparseable": { file: "parseable.ts", symbol: "isParseableTypeString" },
  "info.describes-nothing": {
    file: "compute-annotation.ts",
    symbol: "carriesNoInformation",
  },
  "info.out-of-scope": {
    file: "scope-reachability.ts",
    symbol: "allTypeRefsInScope",
  },
  "gate.polymorphic-this": {
    file: "redundant-annotation.ts",
    symbol: "carriesPolymorphicThis",
  },
  "gate.call-signature": {
    file: "redundant-annotation.ts",
    symbol: "writesOverCallSignature",
  },
  "gate.erases-named-type": {
    file: "redundant-annotation.ts",
    symbol: "erasesNamedType",
  },
  "gate.erases-enum": { file: "redundant-annotation.ts", symbol: "erasesEnum" },
  "gate.discards-union-arm": {
    file: "redundant-annotation.ts",
    symbol: "discardsUnionArm",
  },
  "gate.contradiction": {
    file: "redundant-annotation.ts",
    symbol: "observedBeyondInferred",
  },
  "gate.redundant": {
    file: "redundant-annotation.ts",
    symbol: "isRedundantAnnotation",
  },
  "verify.type-error": {
    file: "apply-types-verify.ts",
    symbol: "filterAcceptedReplacements",
  },
  "verify.wider-after-run": {
    file: "apply-types-verify.ts",
    symbol: "widerTypeWithOthers",
  },
  written: { file: "cst-replacements.ts", symbol: "buildCstReplacements" },
};

/** The order apply asks its rules in, as the page groups them. */
export const STAGES: Array<{ id: string; title: string; rules: ApplyRule[] }> =
  [
    {
      id: "syntax",
      title: "From the code as written",
      rules: [
        "syntax.ignored",
        "syntax.already-typed",
        "syntax.no-site",
        "syntax.outer-conflict",
        "syntax.one-branch-seen",
        "syntax.only-undefined-seen",
        "syntax.as-cast",
        "syntax.as-const",
        "syntax.unique-symbol",
        "syntax.array-callback-shape",
        "syntax.redundant-initializer",
      ],
    },
    {
      id: "info",
      title: "From what the run saw",
      rules: [
        "info.never-passed",
        "info.nothing-left",
        "info.describes-nothing",
        "info.too-long",
        "info.unparseable",
        "info.out-of-scope",
      ],
    },
    {
      id: "gate",
      title: "From what TypeScript infers",
      rules: [
        "gate.polymorphic-this",
        "gate.call-signature",
        "gate.erases-named-type",
        "gate.erases-enum",
        "gate.discards-union-arm",
        "gate.contradiction",
        "gate.redundant",
      ],
    },
    {
      id: "verify",
      title: "From type-checking the file",
      rules: ["verify.type-error", "verify.wider-after-run"],
    },
    { id: "written", title: "Written", rules: ["written"] },
  ];
