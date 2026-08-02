import ts from "typescript";

/**
 * True when an initializer expression is a literal that ts-capture
 * legitimately observes as `undefined` — the user wrote `undefined`
 * (or `void X`) on the right-hand side and the binding's type really
 * is `undefined`. Distinguishes user-intent-undefined from
 * potentially-`T | undefined` opaque call results.
 */
export function isLiteralUndefinedInitializer(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
  if (ts.isVoidExpression(expr)) return true;
  return false;
}

const ARRAY_FIND_LIKE_METHODS: ReadonlySet<string> = new Set(["find", "findLast"]);

/**
 * True for expressions that semantically produce a `T | U` union, where
 * a single-branch observation at runtime would be a regression if used
 * as the binding's only annotation. Recognised shapes:
 *   - `a ?? b` (NullishCoalescing)
 *   - `a || b` (LogicalOr)
 *   - `a && b` (LogicalAnd) — observed-undefined collapses non-undefined branch
 *   - `cond ? a : b` (ConditionalExpression / ternary)
 *   - `obj?.x`, `obj?.()` (any optional chain) — short-circuits to undefined
 *   - `arr.find(...)`, `arr.findLast(...)` — always `T | undefined`
 *
 * Used to detect varDecl positions where a single observation
 * is a narrowing risk: only one branch was seen this session, but the
 * other branch is reachable at runtime and would be rejected if its
 * type were dropped from the annotation.
 */
export function isUnionProducingExpression(expr: ts.Expression): boolean {
  if (ts.isConditionalExpression(expr)) return true;
  if (ts.isBinaryExpression(expr)) {
    const kind = expr.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return true;
    }
  }
  if (
    (ts.isPropertyAccessExpression(expr) ||
      ts.isElementAccessExpression(expr) ||
      ts.isCallExpression(expr)) &&
    expr.questionDotToken
  ) {
    return true;
  }
  if (containsOptionalChain(expr)) return true;
  if (isArrayFindLikeCall(expr)) return true;
  return false;
}

/**
 * True if the expression itself or any direct prefix in a chain uses
 * the `?.` operator. Catches `obj?.a.b` (questionDot on outer access)
 * and `obj?.fn()` (questionDot on the call's expression).
 */
function containsOptionalChain(expr: ts.Expression): boolean {
  let cur: ts.Node = expr;
  while (
    ts.isPropertyAccessExpression(cur) ||
    ts.isElementAccessExpression(cur) ||
    ts.isCallExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    if (
      (ts.isPropertyAccessExpression(cur) ||
        ts.isElementAccessExpression(cur) ||
        ts.isCallExpression(cur)) &&
      cur.questionDotToken
    ) {
      return true;
    }
    cur = ts.isCallExpression(cur)
      ? cur.expression
      : ts.isNonNullExpression(cur)
        ? cur.expression
        : cur.expression;
  }
  return false;
}

/**
 * True for `<arr>.find(...)` / `<arr>.findLast(...)` calls. These methods
 * always return `T | undefined` regardless of the array element type,
 * so a single observed branch is a regression risk.
 */
function isArrayFindLikeCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const name = expr.expression.name;
  if (!ts.isIdentifier(name)) return false;
  return ARRAY_FIND_LIKE_METHODS.has(name.text);
}
