import ts from "typescript";

import type { CollectedTypeInfo } from "./type-collector.js";

// Class-field type inference for the offset-based applier. Pure over a
// `ts.SourceFile` + the file's existing observations; no `ts.Program`.

/**
 * Generate synthetic type-info entries for class instance fields whose
 * type can be inferred from a constructor-param assignment.
 *
 * The transformer only instruments PropertyDeclaration nodes that have
 * an initializer (`count = 0`). Plain field declarations (`count;`) get
 * no observation, so apply leaves them as implicit-any even when the
 * surrounding constructor fully determines the type. Common pattern:
 *
 *   class Counter {
 *     count;
 *     constructor(initial) { this.count = initial; }
 *   }
 *
 * If we have an observation for `initial` (we do — it's a regular
 * function param that the transformer instruments), we can propagate
 * that type to `count` at apply time.
 *
 * Algorithm: for each class, build a map of constructor-param name →
 * observed type using the existing typeInfo; then walk the constructor
 * body for `this.<field> = <ident>` patterns where <ident> is one of
 * the constructor params. For each PropertyDeclaration without an
 * existing type or initializer, emit a synthetic entry at the field's
 * name-end position carrying the param's type.
 *
 * Limitations (deferred):
 * - Doesn't follow `this.x = this.y + 1` or other compound expressions
 * - Doesn't propagate from method assignments (only constructor body)
 * - Doesn't merge with later overwriting `this.x = ...` patterns —
 *   only the param-direct case
 */
export function inferClassFieldTypes(
  source: string,
  typeInfo: CollectedTypeInfo,
): CollectedTypeInfo {
  const sourceFile = ts.createSourceFile(
    "__ts-capture_apply_class_fields.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  // Build a position → observed-type-list map from existing typeInfo so
  // we can look up param types by their declared position.
  const positionTypes = new Map<number, string[]>();
  for (const [, pos, types] of typeInfo) {
    const list = positionTypes.get(pos) ?? [];
    for (const [type] of types) if (type) list.push(type);
    positionTypes.set(pos, list);
  }

  const synthetic: CollectedTypeInfo = [];
  // Inherit the file name from the input typeInfo (assumes caller has
  // grouped by file — applyTypesToFile is single-file by contract).
  const fileName = typeInfo[0]?.[0] ?? "";

  function visitClass(classNode: ts.ClassDeclaration | ts.ClassExpression) {
    const ctor = classNode.members.find(ts.isConstructorDeclaration);
    if (!ctor || !ctor.body) return;

    // Map each constructor param name → its observed (or declared) type.
    const paramTypes = new Map<string, string>();
    for (const param of ctor.parameters) {
      if (!ts.isIdentifier(param.name)) continue;
      if (param.type) {
        // Param already typed in source — use that as truth
        paramTypes.set(param.name.text, param.type.getText(sourceFile));
        continue;
      }
      const obs = positionTypes.get(param.name.end);
      if (obs && obs.length > 0) {
        paramTypes.set(param.name.text, [...new Set(obs)].sort().join("|"));
      }
    }

    if (paramTypes.size === 0) return;

    // Walk the constructor body for `this.<field> = <ident>` assignments.
    const fieldTypes = new Map<string, Set<string>>();
    function visitStmt(node: ts.Node) {
      if (
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.expression.left) &&
        node.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const fieldName = node.expression.left.name.text;
        const rhs = node.expression.right;
        if (ts.isIdentifier(rhs)) {
          const paramType = paramTypes.get(rhs.text);
          if (paramType) {
            const set = fieldTypes.get(fieldName) ?? new Set<string>();
            set.add(paramType);
            fieldTypes.set(fieldName, set);
          }
        }
      }
      ts.forEachChild(node, visitStmt);
    }
    ctor.body.statements.forEach(visitStmt);

    if (fieldTypes.size === 0) return;

    // For each field declaration without an existing type AND without an
    // initializer (already instrumented by the transformer), emit a
    // synthetic entry at the field-name-end position.
    for (const member of classNode.members) {
      if (
        !ts.isPropertyDeclaration(member) ||
        member.type ||
        member.initializer ||
        !ts.isIdentifier(member.name)
      ) {
        continue;
      }
      const types = fieldTypes.get(member.name.text);
      if (!types || types.size === 0) continue;
      const sortedTypes = [...types].sort();
      synthetic.push([
        fileName,
        member.name.end,
        sortedTypes.map((t) => [t, undefined] as [string, undefined]),
        {},
      ]);
    }
  }

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      visitClass(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return synthetic;
}
