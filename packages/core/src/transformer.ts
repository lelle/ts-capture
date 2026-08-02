import ts from "typescript";

import type { ExtraOptions } from "./type-collector.js";

import { findInstrumentationSite } from "./instrumentation-site-spec.js";
import {
  createRegFnWrap,
  createRegisterFnCall,
  createRetCall,
  createTrackCall,
  createTscptrCall,
  getDeclarationStatements,
} from "./transformer-builders.js";

export interface InstrumentOptions {
  instrumentCallExpressions?: boolean;
  instrumentImplicitThis?: boolean;
  skipTscptrDeclarations?: boolean;
  rootDir?: string;
  tsConfig?: string;
  /**
   * Framework-neutral hook for skipping __tscptr__.ret wrapping on a
   * variable / class-field initializer based on the root callee
   * identifier of a call expression. Receives the identifier text at
   * the root of the callee (after walking through property-access
   * chains: `ns.fn.member(...)` → `"ns"`).
   *
   * Adapters use this to opt out of wrapping in contexts where their
   * target framework requires the call to remain the direct RHS — most
   * notably @ts-capture/svelte for Svelte 5 runes (the `$` prefix is
   * reserved and runes must appear unwrapped as the initializer).
   *
   * Core stays framework-neutral; adapters provide the predicate.
   */
  skipInitializerCalleeWhen?: (rootCalleeName: string) => boolean;
}

// --- AST query + rewrite helpers ---

/**
 * Resolve the root callee identifier name of a call expression, walking
 * through property-access chains: `ns.fn.member(...)` → `"ns"`. Returns
 * `null` for non-calls or computed property accesses.
 *
 * Used by the `skipInitializerCalleeWhen` predicate hook so adapters can
 * opt out of varDecl/propertyDecl wrapping based on call-site identity
 * (e.g. @ts-capture/svelte skips $-prefixed calls for Svelte 5 runes).
 */
function getRootCalleeName(expr: ts.Expression): string | null {
  if (!ts.isCallExpression(expr)) return null;
  let callee: ts.Expression = expr.expression;
  while (ts.isPropertyAccessExpression(callee)) {
    callee = callee.expression;
  }
  return ts.isIdentifier(callee) ? callee.text : null;
}

/** Rewrite return statements in a block, stopping at nested function boundaries. */
function rewriteReturns(
  block: ts.Block,
  retPos: number,
  filename: string,
  retOpts: ExtraOptions,
  ctx: ts.TransformationContext,
): ts.Block {
  const returnVisitor: ts.Visitor<ts.Node, ts.Node> = (node) => {
    // Stop at nested function boundaries
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      return node;
    }

    if (ts.isReturnStatement(node) && node.expression) {
      return ts.factory.updateReturnStatement(
        node,
        createRetCall(node.expression, retPos, filename, retOpts),
      );
    }

    return ts.visitEachChild(node, returnVisitor, ctx);
  };

  return ts.visitEachChild(block, returnVisitor, ctx);
}

// --- Parameter helpers ---

function removeInitializerFromBindingElement(node: ts.BindingElement): ts.BindingElement {
  return ts.factory.updateBindingElement(
    node,
    node.dotDotDotToken,
    node.propertyName,
    removeInitializerFromBindingName(node.name),
    undefined,
  );
}

function removeInitializerFromBindingName(node: ts.BindingName): ts.BindingName {
  if (ts.isObjectBindingPattern(node)) {
    return ts.factory.updateObjectBindingPattern(
      node,
      node.elements.map(removeInitializerFromBindingElement),
    );
  } else if (ts.isArrayBindingPattern(node)) {
    return ts.factory.updateArrayBindingPattern(
      node,
      node.elements.map((el) =>
        ts.isOmittedExpression(el) ? el : removeInitializerFromBindingElement(el),
      ),
    );
  }
  return node;
}

function getParameterName(param: ts.ParameterDeclaration): string {
  const { name } = param;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    const cleaned = removeInitializerFromBindingName(name);
    return ts.createPrinter().printNode(ts.EmitHint.Unspecified, cleaned, param.getSourceFile());
  }
  return param.name.getText();
}

/**
 * Collect the per-identifier observation info for params that
 * participate in invocation-site return-type attribution.
 *
 * For each param without an explicit type / initializer:
 *   - Simple identifier `cb` → one entry `{name: "cb", pos: <after cb>, member: "cb"}`.
 *   - Destructured object `{title, render}` → one entry per element, all
 *     sharing the same `pos` (the position after `}`), with `member`
 *     equal to the property's local name. `propertyName` (renaming —
 *     `{title: t}`) is intentionally skipped since the local identifier
 *     the body invokes differs from the property name used in apply's
 *     type-substitution.
 *   - Array destructure / nested patterns: skipped (rare for callback
 *     shapes).
 *
 * The shared `pos` is what `paramReturn` entries are keyed by, matching
 * the param-value observation that `createTscptrCall` emits at the same
 * position. Phase-2 cross-ref uses `member` to find the right slot when
 * the param is a destructured object whose properties are functions.
 */
interface ParamObsInfo {
  name: string;
  pos: number;
  member: string;
}

function collectParamObservationInfo(node: ts.FunctionLikeDeclarationBase): ParamObsInfo[] {
  const result: ParamObsInfo[] = [];
  for (const param of node.parameters) {
    if (param.type || param.initializer || !node.body) continue;
    const obsPos = param.name.getEnd() + (param.questionToken ? 1 : 0);
    if (ts.isIdentifier(param.name)) {
      result.push({ name: param.name.text, pos: obsPos, member: param.name.text });
    } else if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (ts.isIdentifier(el.name) && !el.propertyName) {
          result.push({ name: el.name.text, pos: obsPos, member: el.name.text });
        }
      }
    }
  }
  return result;
}

function findInParamStack(
  stack: ParamObsInfo[][],
  identifierName: string,
): ParamObsInfo | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const match = stack[i].find((p) => p.name === identifierName);
    if (match) return match;
  }
  return undefined;
}

function isRequireContextExpression(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    ts.isIdentifier(node.name) &&
    node.name.text === "context"
  );
}

// --- Node update helpers ---

function updateFunction(
  node: ts.FunctionDeclaration,
  stmts: readonly ts.Statement[],
): ts.FunctionDeclaration {
  return ts.factory.updateFunctionDeclaration(
    node,
    node.modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    node.parameters,
    node.type,
    ts.factory.createBlock([...stmts, ...(node.body ? node.body.statements : [])]),
  );
}

function updateMethod(
  node: ts.MethodDeclaration,
  stmts: readonly ts.Statement[],
): ts.MethodDeclaration {
  return ts.factory.updateMethodDeclaration(
    node,
    node.modifiers,
    node.asteriskToken,
    node.name,
    node.questionToken,
    node.typeParameters,
    node.parameters,
    node.type,
    ts.factory.createBlock([...stmts, ...(node.body ? node.body.statements : [])]),
  );
}

function updateConstructor(
  node: ts.ConstructorDeclaration,
  stmts: readonly ts.Statement[],
): ts.ConstructorDeclaration {
  return ts.factory.updateConstructorDeclaration(
    node,
    node.modifiers,
    node.parameters,
    ts.factory.createBlock([...stmts, ...(node.body ? node.body.statements : [])]),
  );
}

function updateArrow(
  node: ts.ArrowFunction,
  stmts: readonly ts.ExpressionStatement[],
): ts.ArrowFunction {
  const newBody = ts.isBlock(node.body)
    ? ts.factory.createBlock([...stmts, ...node.body.statements])
    : ts.factory.createCommaListExpression([...stmts.map((s) => s.expression), node.body]);

  return ts.factory.updateArrowFunction(
    node,
    node.modifiers,
    node.typeParameters,
    node.parameters,
    node.type,
    node.equalsGreaterThanToken,
    newBody,
  );
}

// --- Instrumentation detection for `this` ---

function needsThisInstrumentation(
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.MethodDeclaration,
  semanticDiagnostics?: readonly ts.Diagnostic[],
): boolean {
  if (!semanticDiagnostics) return false;
  return semanticDiagnostics.some((diag) => {
    if (
      diag.code === 2683 &&
      diag.file &&
      diag.file.fileName === node.getSourceFile().fileName &&
      diag.start !== undefined
    ) {
      if (node.body && ts.isBlock(node.body)) {
        return node.body.statements.some(
          (stmt) => diag.start !== undefined && stmt.pos <= diag.start && diag.start <= stmt.end,
        );
      } else if (node.body) {
        const body = node.body as ts.Expression;
        return body.pos <= diag.start && diag.start <= body.end;
      }
    }
    return false;
  });
}

// --- Main visitor ---

function visitorFactory(
  ctx: ts.TransformationContext,
  source: ts.SourceFile,
  options: InstrumentOptions,
  semanticDiagnostics?: readonly ts.Diagnostic[],
): ts.Visitor<ts.Node, ts.Node> {
  // Stack of enclosing function-likes' param-observation info.
  // Pushed before descending into a function-like's children, popped after.
  // CallExpression visits consult the stack to detect invocations of
  // callback params and wrap them with __tscptr__.ret(..., paramReturn:true).
  const paramStack: ParamObsInfo[][] = [];

  const visitor: ts.Visitor<ts.Node, ts.Node> = (originalNode) => {
    const isFuncLikeOriginal =
      ts.isFunctionDeclaration(originalNode) ||
      ts.isMethodDeclaration(originalNode) ||
      ts.isArrowFunction(originalNode) ||
      ts.isFunctionExpression(originalNode) ||
      ts.isConstructorDeclaration(originalNode);
    let pushedParams = false;
    if (isFuncLikeOriginal) {
      paramStack.push(collectParamObservationInfo(originalNode as ts.FunctionLikeDeclarationBase));
      pushedParams = true;
    }

    const node = ts.visitEachChild(originalNode, visitor, ctx);

    if (pushedParams) paramStack.pop();

    // Inject declarations at source file level
    if (ts.isSourceFile(node) && !options.skipTscptrDeclarations) {
      return ts.factory.updateSourceFile(node, [...getDeclarationStatements(), ...node.statements]);
    }

    // Function/method/arrow/constructor instrumentation
    const isArrow = ts.isArrowFunction(node);
    const isFuncLike =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node);

    if (isFuncLike && node.body) {
      const instrumentStmts: ts.ExpressionStatement[] = [];

      // The return site owns retPos + return opts. retPos is reused below for
      // fnRetPos in param opts and for registerFn / regFn wrapping.
      const returnSite = findInstrumentationSite(
        originalNode as ts.FunctionLikeDeclaration,
        "return",
        source,
      );
      const retPos = returnSite?.pos;

      // Register named functions for cross-referencing
      if (retPos !== undefined && ts.isFunctionDeclaration(node) && node.name) {
        instrumentStmts.push(createRegisterFnCall(node.name.text, retPos, source.fileName));
      }

      // Implicit this instrumentation
      if (
        options.instrumentImplicitThis &&
        !ts.isConstructorDeclaration(node) &&
        needsThisInstrumentation(
          node as ts.FunctionDeclaration | ts.ArrowFunction | ts.MethodDeclaration,
          semanticDiagnostics,
        )
      ) {
        const site = findInstrumentationSite(
          node as ts.FunctionLikeDeclaration,
          "implicitThis",
          source,
        )!;
        instrumentStmts.push(createTscptrCall("this", site.pos, source.fileName, site.opts));
      }

      // Parameter instrumentation
      for (const param of node.parameters) {
        if (!param.type && !param.initializer && node.body) {
          const site = findInstrumentationSite(param, "param", source, {
            fn: node as ts.FunctionLikeDeclarationBase,
            fnRetPos: retPos,
          })!;
          instrumentStmts.push(
            createTscptrCall(getParameterName(param), site.pos, source.fileName, site.opts),
          );
        }
      }

      let retNode = node;
      if (returnSite && retPos !== undefined) {
        const retOpts = returnSite.opts;

        if (isArrow && !ts.isBlock(node.body!)) {
          // Arrow expression body: wrap the expression
          const wrappedBody = createRetCall(
            node.body as ts.Expression,
            retPos,
            source.fileName,
            retOpts,
          );
          retNode = ts.factory.updateArrowFunction(
            node as ts.ArrowFunction,
            (node as ts.ArrowFunction).modifiers,
            (node as ts.ArrowFunction).typeParameters,
            (node as ts.ArrowFunction).parameters,
            (node as ts.ArrowFunction).type,
            (node as ts.ArrowFunction).equalsGreaterThanToken,
            wrappedBody,
          );
        } else if (node.body && ts.isBlock(node.body)) {
          // Block body: rewrite return statements
          const rewrittenBody = rewriteReturns(node.body, retPos, source.fileName, retOpts, ctx);
          if (ts.isFunctionDeclaration(node)) {
            retNode = ts.factory.updateFunctionDeclaration(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.typeParameters,
              node.parameters,
              node.type,
              rewrittenBody,
            );
          } else if (ts.isMethodDeclaration(node)) {
            retNode = ts.factory.updateMethodDeclaration(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.questionToken,
              node.typeParameters,
              node.parameters,
              node.type,
              rewrittenBody,
            );
          } else if (ts.isArrowFunction(node)) {
            retNode = ts.factory.updateArrowFunction(
              node,
              node.modifiers,
              node.typeParameters,
              node.parameters,
              node.type,
              node.equalsGreaterThanToken,
              rewrittenBody,
            );
          }
        }
      }

      if (ts.isFunctionDeclaration(retNode))
        return updateFunction(retNode as ts.FunctionDeclaration, instrumentStmts);
      if (ts.isMethodDeclaration(retNode))
        return updateMethod(retNode as ts.MethodDeclaration, instrumentStmts);
      if (ts.isConstructorDeclaration(retNode))
        return updateConstructor(retNode as ts.ConstructorDeclaration, instrumentStmts);
      if (ts.isArrowFunction(retNode)) {
        const updated = updateArrow(retNode as ts.ArrowFunction, instrumentStmts);
        // Wrap inline arrows in __tscptr__.regFn so the runtime
        // captures their identity at creation time. registerFn-by-name
        // only works for named function decls; inline arrows in JSX
        // attrs / call args / variable initializers need value-based
        // registration.
        if (retPos !== undefined) {
          return createRegFnWrap(updated, retPos, source.fileName);
        }
        return updated;
      }
    }

    // Call expression handling: arg-tracking + paramReturn wrap
    if (ts.isCallExpression(node) && !isRequireContextExpression(node.expression)) {
      let callNode: ts.CallExpression = node;

      if (options.instrumentCallExpressions) {
        const newArgs = node.arguments.map((arg) => {
          if (
            node.getSourceFile() &&
            !ts.isStringLiteral(arg) &&
            !ts.isNumericLiteral(arg) &&
            !ts.isSpreadElement(arg)
          ) {
            return createTrackCall(arg, source.fileName, arg.getStart());
          }
          return arg;
        });
        callNode = ts.factory.updateCallExpression(
          node,
          node.expression,
          node.typeArguments,
          newArgs,
        );
      }

      // When the callee is an identifier that resolves to an enclosing
      // function's callback param, wrap the call with __tscptr__.ret keyed
      // to the param's observation pos. The recorded return type is
      // attributed to the param's slot during Phase-2 cross-ref, so
      // apply can emit `cb(x: T): R` instead of `cb(x: T): unknown`
      // when the parent's callback isn't otherwise observable to
      // ts-capture.
      if (ts.isIdentifier(callNode.expression)) {
        const match = findInParamStack(paramStack, callNode.expression.text);
        if (match) {
          const site = findInstrumentationSite(callNode, "paramReturn", source, {
            paramReturnPos: match.pos,
            paramReturnMember: match.member,
          })!;
          return createRetCall(callNode, site.pos, source.fileName, site.opts);
        }
      }

      if (callNode !== node) return callNode;
    }

    // Variable declaration instrumentation: let x = expr → let x = __tscptr__.ret(expr, pos, ...)
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      !node.type &&
      ts.isIdentifier(node.name) // skip destructuring
    ) {
      // Framework-neutral skip hook: adapters opt out of wrapping based
      // on call-site identity (e.g. @ts-capture/svelte skips Svelte 5
      // rune calls so $state(...)/$derived(...) remain the direct RHS).
      const calleeName = getRootCalleeName(node.initializer);
      const skip = calleeName !== null && options.skipInitializerCalleeWhen?.(calleeName) === true;
      if (!skip) {
        const site = findInstrumentationSite(node, "varDecl", source)!;
        return ts.factory.updateVariableDeclaration(
          node,
          node.name,
          node.exclamationToken,
          node.type,
          createRetCall(node.initializer, site.pos, source.fileName, site.opts),
        );
      }
    }

    // Class property instrumentation: name = expr → name = __tscptr__.ret(expr, pos, ...)
    if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      !node.type &&
      ts.isIdentifier(node.name)
    ) {
      const calleeName = getRootCalleeName(node.initializer);
      const skip = calleeName !== null && options.skipInitializerCalleeWhen?.(calleeName) === true;
      if (!skip) {
        const site = findInstrumentationSite(node, "propertyDecl", source)!;
        return ts.factory.updatePropertyDeclaration(
          node,
          node.modifiers,
          node.name,
          node.questionToken ?? node.exclamationToken,
          node.type,
          createRetCall(node.initializer, site.pos, source.fileName, site.opts),
        );
      }
    }

    return node;
  };

  return visitor;
}

// --- Public API ---

export function tsCaptureTransformer(
  options: InstrumentOptions,
  program?: ts.Program,
): ts.TransformerFactory<ts.SourceFile> {
  return (ctx) => (source) => {
    const diagnostics =
      options.instrumentImplicitThis && program
        ? program.getSemanticDiagnostics(source)
        : undefined;
    return ts.visitNode(source, visitorFactory(ctx, source, options, diagnostics)) as ts.SourceFile;
  };
}

export function transformSourceFile(
  sourceFile: ts.SourceFile,
  options: InstrumentOptions = {},
  program?: ts.Program,
): ts.SourceFile {
  return ts.transform(sourceFile, [tsCaptureTransformer(options, program)]).transformed[0];
}
