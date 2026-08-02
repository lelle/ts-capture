import ts from "typescript";

import type { InferOptions } from "./configuration.js";

import {
  isLiteralUndefinedInitializer,
  isUnionProducingExpression,
} from "./expression-predicates.js";

// The visit-indexer for the AST-aware applier. A
// single walk over a parsed `ts.SourceFile` produces every offset-keyed apply
// site the downstream routing / replacement phases need. Pure: source file +
// inference flags in, `CstSiteIndex` out — no `typeInfo`, no replacements, no
// I/O.

// Param sites: pos in typeInfo for a param matches
// `param.name.end + (questionToken ? 1 : 0)` — mirrors the transformer's
// param-observation emit (transformer.ts, visitorFactory).
// Indexes both Identifier-named params and BindingPattern (object /
// array destructure) params; only skips already-typed params (those
// are no-ops by AST-native idempotency).
//
// `parensOpenPos` is set for paren-less single-param arrow functions
// (`x => body`), where the apply step needs to insert `(` before the
// param in addition to `: T)` at name.end. This mirrors the offset-
// based path's `opts.parens` handling.
export type ParamSite = {
  node: ts.ParameterDeclaration;
  parensOpenPos?: number;
};

// ThisType sites: indexed by `function.parameters.pos` (right after
// the opening `(`). The transformer emits one of these when a function
// body uses `this` implicitly and TS would otherwise complain. Apply
// inserts `this: T` (or `this: T, ` if other params follow).
export type ThisTypeSite = { hasOtherParams: boolean };

// Return-type sites: indexed by the same pos the transformer emits
// for returnType entries — `findCloseParenPos` in transformer.ts.
// For functions with `(...)`, that's `closeParen.end`; for paren-less
// single-param arrows (`x => body`), that's `parameters.end`.
export type ReturnTypeSite = { hasReturnType: boolean };

// VarDecl + class-field sites: indexed by `node.name.end` to match
// the transformer's varDecl pos.
// Carries everything the apply-time guards need:
//   - `hasType`: AST-native idempotency (skip when node already has
//      an annotation)
//   - `rhsIsFunction`: never insert outer annotation when RHS is a
//      function expression (would be contravariantly incompatible
//      with inner observations)
//   - `initializer` + `narrowsLiterals`: let
//      `infer.skipInferableVarDecls` skip when TS would already
//      infer the same type from the initializer
export type VarDeclSite = {
  hasType: boolean;
  rhsIsFunction: boolean;
  initializer: ts.Expression | undefined;
  narrowsLiterals: boolean;
  /** Initializer is `call<X>(...)` — position already typed via generic arg. */
  hasInitializerTypeArguments: boolean;
  /** Some enclosing function carries type parameters. */
  inGenericContext: boolean;
  /** Initializer is `??`, `||`, or ternary — union-producing. */
  isUnionProducingInitializer: boolean;
  /** Initializer is NOT a literal undefined / void X. */
  hasOpaqueInitializer: boolean;
};

/** All AST-derived apply sites for one source file, keyed by offset. */
export interface CstSiteIndex {
  paramSites: Map<number, ParamSite>;
  thisTypeSites: Map<number, ThisTypeSite>;
  returnTypeSites: Map<number, ReturnTypeSite>;
  varDeclSites: Map<number, VarDeclSite>;
  /**
   * Param-end positions of arrow / function-expression callbacks passed to
   * well-known `Array.prototype` methods (filter, map, find, …). When the
   * would-be annotation at one of these positions resolves to a structural
   * object type (`{ ... }`), apply skips it: TS already contextually types the
   * callback from the array's element type, so inlining the shape per callsite
   * — and multiplying across chained `.filter().map().some()` — adds noise
   * without value. Primitive emits (`number`, `string`, …) pass through.
   */
  arrayCallbackArrowParams: Set<number>;
  /**
   * Source ranges the user has explicitly opted out of via
   * `// @ts-capture-ignore` (or block-comment form) on the line preceding a
   * declaration. Apply skips any insertion position contained in these ranges.
   */
  ignoredRanges: Array<[number, number]>;
}

const ARRAY_CB_METHODS_CST: ReadonlySet<string> = new Set([
  "filter",
  "map",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "forEach",
  "some",
  "every",
  "reduce",
  "reduceRight",
  "flatMap",
  "sort",
]);

const TS_CAPTURE_IGNORE_RE_CST = /@ts-capture-ignore\b/;

/**
 * Walk `sf` once and build every offset-keyed apply site. `source` is the raw
 * text `sf` was parsed from (used for leading-comment scanning); `infer` is
 * consulted only for `ignoreExistingTypes` (whether already-typed params are
 * still indexed).
 */
export function buildCstSiteIndex(
  sf: ts.SourceFile,
  source: string,
  infer: InferOptions,
): CstSiteIndex {
  const paramSites = new Map<number, ParamSite>();
  const arrayCallbackArrowParams = new Set<number>();
  const thisTypeSites = new Map<number, ThisTypeSite>();
  const returnTypeSites = new Map<number, ReturnTypeSite>();
  const varDeclSites = new Map<number, VarDeclSite>();
  const ignoredRanges: Array<[number, number]> = [];
  const fnStack: ts.SignatureDeclaration[] = [];

  function findReturnTypePos(fn: ts.SignatureDeclarationBase): number {
    // Mirror transformer.ts:findCloseParenPos. Paren-less single-param
    // arrows have no `)` to scan to — fall back to parameters.end.
    if (
      ts.isArrowFunction(fn) &&
      fn.parameters.length === 1 &&
      // Paren-less iff first param's pos equals the function's pos
      // (modulo modifiers, which arrows can have via `async`).
      fn.parameters[0].pos === (fn.modifiers ? Math.max(...fn.modifiers.map((m) => m.end)) : fn.pos)
    ) {
      return fn.parameters.end;
    }
    const text = sf.getFullText();
    let pos = fn.parameters.end;
    const limit = Math.min(text.length, fn.end);
    while (pos < limit && text[pos] !== ")") pos++;
    if (pos >= limit) return fn.parameters.end;
    return pos + 1;
  }

  function hasIgnoreLeadingComment(node: ts.Node): boolean {
    const ranges = ts.getLeadingCommentRanges(source, node.pos);
    if (!ranges) return false;
    return ranges.some((r) => TS_CAPTURE_IGNORE_RE_CST.test(source.slice(r.pos, r.end)));
  }

  function visit(node: ts.Node) {
    // Index arrow / function-expression params AND
    // returnType positions of calls to Array.prototype contextually-
    // typing methods. Both kinds of annotations get suppressed when
    // emitted is a structural object type.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      ARRAY_CB_METHODS_CST.has(node.expression.name.text)
    ) {
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          for (const param of arg.parameters) {
            if (ts.isIdentifier(param.name)) {
              arrayCallbackArrowParams.add(param.name.end);
            }
          }
          // Arrow returnType position — see findReturnTypePos for the
          // paren-less / paren-wrapped distinction.
          arrayCallbackArrowParams.add(findReturnTypePos(arg));
        }
      }
    }
    if (ts.isParameter(node) && (!node.type || infer.ignoreExistingTypes)) {
      // BindingPattern.end gives the position after the closing `}` /
      // `]`, which is exactly where ts-capture's destructure-param
      // annotation should land. positionLooksLikeInsertionSite in the
      // offset-based path accepts `}` and `]` as before-chars for the
      // same reason.
      const indexPos = node.name.end + (node.questionToken ? 1 : 0);
      // Detect paren-less single-param arrow context. Mirrors
      // transformer.ts:hasParensAroundArguments. The arrow's parent is
      // an ArrowFunction (we walked into here from a Parameter visit);
      // we need to walk up to confirm.
      let parensOpenPos: number | undefined;
      const parent = node.parent;
      if (
        parent &&
        ts.isArrowFunction(parent) &&
        parent.parameters.length === 1 &&
        parent.parameters[0] === node
      ) {
        const paramStart = parent.modifiers
          ? Math.max(...parent.modifiers.map((m) => m.end))
          : parent.pos;
        if (node.pos === paramStart) parensOpenPos = node.getStart(sf);
      }
      paramSites.set(indexPos, { node, parensOpenPos });
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      // Skip generators (transformer skips return-type instrumentation
      // for them) and constructors (no return type).
      const asteriskToken = (node as ts.FunctionDeclaration).asteriskToken;
      if (!asteriskToken) {
        const retPos = findReturnTypePos(node);
        returnTypeSites.set(retPos, { hasReturnType: !!node.type });
      }
      // `this` type insertion site: parameters.pos is right after the
      // opening `(`. The transformer only emits a thisType entry when
      // the function actually needs one (semantic-diagnostic-driven),
      // so we just pre-index every function's slot — entries that don't
      // arrive simply don't trigger insertion.
      thisTypeSites.set(node.parameters.pos, {
        hasOtherParams: node.parameters.length > 0,
      });
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      const list = node.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      varDeclSites.set(node.name.end, {
        hasType: !!node.type,
        rhsIsFunction:
          !!initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)),
        initializer,
        narrowsLiterals: isConst,
        hasInitializerTypeArguments:
          !!initializer &&
          ts.isCallExpression(initializer) &&
          !!initializer.typeArguments &&
          initializer.typeArguments.length > 0,
        inGenericContext: fnStack.some((f) => f.typeParameters && f.typeParameters.length > 0),
        isUnionProducingInitializer: !!initializer && isUnionProducingExpression(initializer),
        hasOpaqueInitializer: !!initializer && !isLiteralUndefinedInitializer(initializer),
      });
    }
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      const isReadonly =
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      varDeclSites.set(node.name.end, {
        hasType: !!node.type,
        rhsIsFunction:
          !!initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)),
        initializer,
        narrowsLiterals: isReadonly,
        hasInitializerTypeArguments:
          !!initializer &&
          ts.isCallExpression(initializer) &&
          !!initializer.typeArguments &&
          initializer.typeArguments.length > 0,
        inGenericContext: fnStack.some((f) => f.typeParameters && f.typeParameters.length > 0),
        isUnionProducingInitializer: !!initializer && isUnionProducingExpression(initializer),
        hasOpaqueInitializer: !!initializer && !isLiteralUndefinedInitializer(initializer),
      });
    }
    // Collect ignored ranges for declarations with a leading
    // @ts-capture-ignore comment.
    if (
      (ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isExpressionStatement(node)) &&
      hasIgnoreLeadingComment(node)
    ) {
      ignoredRanges.push([node.pos, node.end]);
    }

    const pushedFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    if (pushedFn) fnStack.push(node as ts.SignatureDeclaration);
    ts.forEachChild(node, visit);
    if (pushedFn) fnStack.pop();
  }

  visit(sf);

  return {
    paramSites,
    thisTypeSites,
    returnTypeSites,
    varDeclSites,
    arrayCallbackArrowParams,
    ignoredRanges,
  };
}
