import ts from "typescript";

/**
 * For each var-decl / class-field declaration with an initializer, record
 * the initializer expression and a "narrows-to-literal" flag. Apply uses
 * this to detect when an observed type would match what TS already
 * infers from the initializer.
 *
 * The flag determines whether primitive literals stay narrow or widen:
 * - `let x = 5`: TS infers `number` (widened).
 * - `const x = 5`: TS infers `5` (narrow literal).
 * - `class C { x = 5 }`: TS infers `number` (widened).
 * - `class C { readonly x = 5 }`: TS infers `5` (narrow literal).
 *
 * ts-capture emits the widened form by default, so suppression is safe
 * only when the binding's inferred type WIDENS to the same shape.
 */
export type InferableInfo = { initializer: ts.Expression; narrowsLiterals: boolean };

export function buildInferableInfoMap(source: string): Map<number, InferableInfo> {
  const map = new Map<number, InferableInfo>();
  const sourceFile = ts.createSourceFile(
    "__ts-capture_inferable.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = node.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      map.set(node.name.end, { initializer: node.initializer, narrowsLiterals: isConst });
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const isReadonly =
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      map.set(node.name.end, { initializer: node.initializer, narrowsLiterals: isReadonly });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return map;
}

/**
 * Returns true when `expr` is `<x> as const` — the TS form that
 * recursively narrows literals on the wrapped expression.
 *
 * `as const` parses as an `AsExpression` whose `.type` is a
 * `TypeReferenceNode` with the identifier "const". (TSX disallows the
 * `<const>x` prefix form, so only AsExpression matters in practice.)
 */
function isAsConst(expr: ts.Expression): boolean {
  if (!ts.isAsExpression(expr)) return false;
  const type = expr.type;
  return (
    ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "const"
  );
}

/**
 * Compute the type TypeScript would infer from an initializer expression
 * via syntactic rules only — no type checker, no semantic resolution.
 * Returns null when the shape isn't one we can confidently model
 * (function calls, identifiers, complex expressions).
 *
 * `narrowsLiterals` mirrors the binding's literal-widening behaviour:
 * `const x = 5` and `readonly foo = 5` both narrow to literal type `5`.
 * We still return the WIDENED type ("number") so the caller's equality
 * check can suppress ts-capture's redundant-or-widening annotation.
 * For the literal-narrowing case, returning "number" means ts-capture's
 * `: number` emit matches and gets skipped — which is the right outcome:
 * TS already narrows the binding to `5`, and ts-capture adding
 * `: number` would only *broaden* it (strictly worse type info).
 */
export function inferTypeFromInitializer(
  expr: ts.Expression,
  _narrowsLiterals: boolean,
): string | null {
  // Unwrap parens. `const x = (5)` has the same inferred type as `const x = 5`.
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

  // Peel `as const`: the inner expression's literals are narrowed.
  // Re-enter with narrowsLiterals: true (which no longer changes
  // primitive returns, but DOES propagate into the object/array
  // recursion below).
  if (isAsConst(expr)) {
    return inferTypeFromInitializer((expr as ts.AsExpression).expression, true);
  }

  if (ts.isNumericLiteral(expr)) return "number";
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return "string";
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return "boolean";
  }
  // Template strings with substitutions always widen to `string`, no
  // narrowing even for `const`.
  if (ts.isTemplateExpression(expr)) return "string";

  // Array literals widen for both `let` and `const` (and class fields):
  // `const arr = [1, 2, 3]` is `number[]`, not `[1, 2, 3]`. Detect
  // homogeneous primitive arrays (the common case); mixed-type arrays
  // would need union handling we don't model here.
  if (ts.isArrayLiteralExpression(expr)) {
    if (expr.elements.length === 0) return null; // `[]` infers `any[]`/`never[]` — not safe to suppress
    const elementTypes = new Set<string>();
    for (const el of expr.elements) {
      const t = primitiveLiteralWidenedType(el);
      if (t === null) return null;
      elementTypes.add(t);
    }
    if (elementTypes.size === 1) return [...elementTypes][0] + "[]";
    return null; // heterogeneous — leave to ts-capture's observation
  }

  // Object literals widen for both let/const. Build the same shape
  // ts-capture would emit (sorted keys, `{ k: T }` format).
  if (ts.isObjectLiteralExpression(expr)) {
    const pairs: string[] = [];
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) return null; // shorthand / spread / methods → bail
      const valueType = inferTypeFromInitializer(prop.initializer, false);
      if (valueType === null) return null;
      let key: string;
      if (ts.isIdentifier(prop.name)) key = prop.name.text;
      else if (ts.isStringLiteral(prop.name)) key = JSON.stringify(prop.name.text);
      else return null; // computed names / numeric keys → bail
      pairs.push(`${key}: ${valueType}`);
    }
    if (pairs.length === 0) return "{}";
    pairs.sort();
    return `{ ${pairs.join(", ")} }`;
  }

  // `new Identifier(...)`: TS infers the identifier as the type. Skip
  // qualified names (`new ns.Cls()`) and call expressions on the ctor.
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text;
  }

  return null;
}

function primitiveLiteralWidenedType(expr: ts.Expression): string | null {
  if (ts.isNumericLiteral(expr)) return "number";
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return "string";
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return "boolean";
  }
  return null;
}
