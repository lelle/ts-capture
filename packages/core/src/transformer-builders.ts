import ts from "typescript";

import type { ExtraOptions } from "./type-collector.js";

// Instrumentation AST-node builders for the transformer. Pure ts.factory constructors for
// the $_$tscptr$ collector calls + the runtime declaration block. Leaf module:
// each builds nodes and calls only its siblings.

const tscptrDeclaration = `
declare function __tscptr__(name: string, value: any, pos: number, filename: string, opts: any): void;
declare namespace __tscptr__ {
    function track<T>(value: T, filename: string, offset: number): T;
    function track(value: any, filename: string, offset: number): any;
    function ret<T>(value: T, pos: number, filename: string, opts: any): T;
    function ret(value: any, pos: number, filename: string, opts: any): any;
    function registerFn(fn: Function, retPos: number, filename: string): void;
}
`;

export function getDeclarationStatements(): readonly ts.Statement[] {
  const stmts = ts.createSourceFile(
    "tscptr-declarations.ts",
    tscptrDeclaration,
    ts.ScriptTarget.Latest,
  ).statements;
  // Mark each statement as synthesized so the TypeScript printer doesn't try
  // to inherit leading-trivia comments from the user's source file at the
  // (foreign) positions these nodes were parsed from. Without this, comments
  // between the user's import header and first declaration get spliced into
  // the `declare namespace` keyword line.
  for (const stmt of stmts) {
    setPositionsRecursive(stmt);
  }
  return stmts;
}

function setPositionsRecursive(node: ts.Node): void {
  ts.setTextRange(node, { pos: -1, end: -1 });
  ts.forEachChild(node, setPositionsRecursive);
}

export function createTscptrCall(
  name: string,
  fileOffset: number,
  filename: string,
  opts: ExtraOptions,
): ts.ExpressionStatement {
  return ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(ts.factory.createIdentifier("__tscptr__"), undefined, [
      ts.factory.createStringLiteral(name),
      ts.factory.createIdentifier(name),
      ts.factory.createNumericLiteral(fileOffset),
      ts.factory.createStringLiteral(filename),
      ts.factory.createStringLiteral(JSON.stringify(opts)),
    ]),
  );
}

export function createTrackCall(
  arg: ts.Expression,
  filename: string,
  offset: number,
): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("__tscptr__"),
      ts.factory.createIdentifier("track"),
    ),
    undefined,
    [arg, ts.factory.createStringLiteral(filename), ts.factory.createNumericLiteral(offset)],
  );
}

export function createRegisterFnCall(
  fnName: string,
  retPos: number,
  filename: string,
): ts.ExpressionStatement {
  return ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier("__tscptr__"),
        ts.factory.createIdentifier("registerFn"),
      ),
      undefined,
      [
        ts.factory.createIdentifier(fnName),
        ts.factory.createNumericLiteral(retPos),
        ts.factory.createStringLiteral(filename),
      ],
    ),
  );
}

/**
 * Wraps an arrow / function-expression with `__tscptr__.regFn(fn, retPos, filename)`
 * so the runtime registers it for cross-position signature inference at
 * creation time. Returns the value through (the wrapper is identity-
 * preserving) so the AST substitution stays expression-compatible.
 *
 * Inline arrows passed as callback props (`render={(t) => …}`) have no
 * name; `registerFn(name, retPos, filename)` can't reach them. Wrapping
 * them at the call/JSX-attr site captures the function value AT
 * creation, so when the same value is observed elsewhere (e.g. at the
 * prop destructure of the receiving component), the cross-ref logic in
 * `getCollectedTypes` upgrades the generic `(…) => unknown` shape to
 * the full observed signature.
 */
export function createRegFnWrap(
  fn: ts.Expression,
  retPos: number,
  filename: string,
): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("__tscptr__"),
      ts.factory.createIdentifier("regFn"),
    ),
    undefined,
    [fn, ts.factory.createNumericLiteral(retPos), ts.factory.createStringLiteral(filename)],
  );
}

export function createRetCall(
  expr: ts.Expression,
  retPos: number,
  filename: string,
  opts: ExtraOptions,
): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("__tscptr__"),
      ts.factory.createIdentifier("ret"),
    ),
    undefined,
    [
      expr,
      ts.factory.createNumericLiteral(retPos),
      ts.factory.createStringLiteral(filename),
      ts.factory.createStringLiteral(JSON.stringify(opts)),
    ],
  );
}
