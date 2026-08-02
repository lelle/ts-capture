import ts from "typescript";

import type { ExtraOptions } from "./collector-contract.js";

// Single source of truth for the (kind, node) → (pos, opts) instrumentation
// contract. The transformer consumes this to emit `__tscptr__` probes; the
// collector keys every observation by exactly the `(pos, opts)` produced here.

export type InstrumentationKind =
  "param" | "return" | "varDecl" | "propertyDecl" | "implicitThis" | "paramReturn";

export interface InstrumentationSite {
  kind: InstrumentationKind;
  /** Exact source offset the probe reads at — what the collector keys on. */
  pos: number;
  /** The opts the probe carries — what the collector demuxes by. */
  opts: ExtraOptions;
}

export interface SiteContext {
  /** `param`: the enclosing function (for arrow / parens) and its return pos. */
  fn?: ts.FunctionLikeDeclarationBase;
  fnRetPos?: number;
  /** `paramReturn`: the matched callback-param observation pos + member. */
  paramReturnPos?: number;
  paramReturnMember?: string;
}

/**
 * Resolve the instrumentation site for a node, or null when this node/kind
 * should not be instrumented. Pure: depends only on the node, its kind, the
 * SourceFile (for offset math), and the small `context` the visitor supplies.
 */
export function findInstrumentationSite(
  node: ts.Node,
  kind: InstrumentationKind,
  sourceFile: ts.SourceFile,
  context: SiteContext = {},
): InstrumentationSite | null {
  switch (kind) {
    case "param":
      return paramSite(node as ts.ParameterDeclaration, sourceFile, context);
    case "return":
      return returnSite(node as ts.FunctionLikeDeclaration, sourceFile);
    case "varDecl":
      return varDeclSite(node as ts.VariableDeclaration);
    case "propertyDecl":
      return propertyDeclSite(node as ts.PropertyDeclaration);
    case "implicitThis":
      return implicitThisSite(node as ts.FunctionLikeDeclaration);
    case "paramReturn":
      return paramReturnSite(context);
  }
}

function paramSite(
  param: ts.ParameterDeclaration,
  sourceFile: ts.SourceFile,
  context: SiteContext,
): InstrumentationSite | null {
  const fn = context.fn;
  if (!fn) return null;
  const pos = param.name.getEnd() + (param.questionToken ? 1 : 0);
  const opts: ExtraOptions = {};
  if (ts.isArrowFunction(fn)) opts.arrow = true;
  if (!hasParensAroundArguments(fn)) {
    opts.parens = [fn.parameters[0].getStart(sourceFile), fn.parameters[0].getEnd()];
  }
  if (context.fnRetPos !== undefined) opts.fnRetPos = context.fnRetPos;
  return { kind: "param", pos, opts };
}

function returnSite(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
): InstrumentationSite | null {
  const shouldInstrument =
    !ts.isConstructorDeclaration(node) &&
    !(node as ts.FunctionDeclaration).asteriskToken &&
    !node.type;
  if (!shouldInstrument) return null;
  const opts: ExtraOptions = { returnType: true };
  if (isAsync(node)) opts.async = true;
  return { kind: "return", pos: findCloseParenPos(node, sourceFile), opts };
}

function varDeclSite(node: ts.VariableDeclaration): InstrumentationSite {
  const opts: ExtraOptions = { varDecl: true };
  if (node.initializer && rhsHasTypeAssertion(node.initializer)) {
    opts.hasAsCast = true;
  }
  return { kind: "varDecl", pos: node.name.getEnd(), opts };
}

function propertyDeclSite(node: ts.PropertyDeclaration): InstrumentationSite {
  return { kind: "propertyDecl", pos: node.name.getEnd(), opts: { varDecl: true } };
}

function implicitThisSite(node: ts.FunctionLikeDeclaration): InstrumentationSite {
  const opts: ExtraOptions = { thisType: true };
  if (node.parameters.length > 0) opts.thisNeedsComma = true;
  return { kind: "implicitThis", pos: node.parameters.pos, opts };
}

function paramReturnSite(context: SiteContext): InstrumentationSite | null {
  if (context.paramReturnPos === undefined || context.paramReturnMember === undefined) {
    return null;
  }
  return {
    kind: "paramReturn",
    pos: context.paramReturnPos,
    opts: { paramReturn: true, paramReturnMember: context.paramReturnMember },
  };
}

// --- Offset / opts helpers, ported verbatim from transformer.ts ---

function findCloseParenPos(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile): number {
  // Paren-less arrow (`x => body`): no `)` exists. Falling through to the
  // forward-scan would walk past the function's own bounds and land on
  // some downstream `)`, so apply would splice a return annotation
  // mid-statement. Use parameters.end instead — apply co-locates the
  // synthetic `)` from the parens opt at the same pos.
  if (!hasParensAroundArguments(node)) {
    return node.parameters.end;
  }
  const text = sourceFile.getFullText();
  let pos = node.parameters.end;
  const limit = Math.min(text.length, node.end);
  while (pos < limit && text[pos] !== ")") pos++;
  if (pos >= limit) return node.parameters.end;
  return pos + 1; // position after ')'
}

function hasParensAroundArguments(node: ts.FunctionLikeDeclarationBase): boolean {
  if (ts.isArrowFunction(node)) {
    const paramStart = node.modifiers ? Math.max(...node.modifiers.map((m) => m.end)) : node.pos;
    return node.parameters.length !== 1 || node.parameters[0].pos !== paramStart;
  }
  return true;
}

function isAsync(node: ts.FunctionLikeDeclaration): boolean {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/**
 * Detect a type assertion — `expr as T`, `<T>expr`, or either wrapped in
 * parens. `as const` is intentionally NOT a cast (literal-narrowing hint).
 */
function rhsHasTypeAssertion(expr: ts.Expression): boolean {
  let inner: ts.Expression = expr;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (ts.isAsExpression(inner)) {
    return !(
      ts.isTypeReferenceNode(inner.type) &&
      ts.isIdentifier(inner.type.typeName) &&
      inner.type.typeName.text === "const"
    );
  }
  return ts.isTypeAssertionExpression(inner);
}
