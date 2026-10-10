import ts from "typescript";

// An observed parameter shape is the caller's object, every key of it. The
// function body says which of those keys it needs. This module cuts the shape
// down to those, when the body is the only place the parameter goes: once it
// is passed on, returned or stored, what the rest of the program expects of it
// is out of sight, and the whole shape stays.

const NULL_CHECK_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * The observed shape with only the properties the function body reads from
 * the parameter, or the shape as given when the body does not settle what the
 * parameter needs: no body, no reads, a use that lets the whole value escape,
 * or a member no property name can keep.
 *
 * Only the object arms at the top level are narrowed; a shape inside an array
 * or a generic is one the body reaches through other code.
 */
export function narrowParamShape(emitted: string, param: ts.ParameterDeclaration): string {
  const reads = propertiesRead(param);
  if (!reads || reads.size === 0) return emitted;

  const prefix = "type __X = ";
  const sf = ts.createSourceFile(
    "__narrow_probe.ts",
    `${prefix}${emitted};`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
  const stmt = sf.statements[0];
  if (!stmt || !ts.isTypeAliasDeclaration(stmt)) return emitted;
  const top = deparen(stmt.type);
  const arms = ts.isUnionTypeNode(top) ? top.types.map(deparen) : [top];

  let out = emitted;
  for (const arm of [...arms].reverse()) {
    if (!ts.isTypeLiteralNode(arm)) continue;
    const narrowed = narrowLiteral(arm, reads, sf);
    if (narrowed === undefined) continue;
    const start = arm.getStart(sf) - prefix.length;
    const end = arm.getEnd() - prefix.length;
    out = out.slice(0, start) + narrowed + out.slice(end);
  }
  return out;
}

/** The literal with only the read members, or undefined when it should stay as it is. */
function narrowLiteral(
  literal: ts.TypeLiteralNode,
  reads: ReadonlySet<string>,
  sf: ts.SourceFile,
): string | undefined {
  const kept: string[] = [];
  for (const member of literal.members) {
    if (!ts.isPropertySignature(member)) return undefined;
    const name = propertyName(member.name);
    if (name === undefined) return undefined;
    // A member's text carries the separator after it.
    if (reads.has(name)) kept.push(member.getText(sf).replace(/[,;]\s*$/, ""));
  }
  if (kept.length === 0 || kept.length === literal.members.length) return undefined;
  return `{ ${kept.join(", ")} }`;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function deparen(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  return current;
}

/**
 * The property names the body reads from the parameter, or undefined when
 * the parameter escapes the body as a whole value.
 */
function propertiesRead(param: ts.ParameterDeclaration): Set<string> | undefined {
  const fn = param.parent;
  if (!ts.isFunctionLike(fn) || !("body" in fn) || fn.body === undefined) return undefined;
  if (ts.isObjectBindingPattern(param.name)) return boundKeys(param.name);
  if (!ts.isIdentifier(param.name)) return undefined;

  const name = param.name.text;
  const reads = new Set<string>();
  let escapes = false;

  const visit = (node: ts.Node): void => {
    if (escapes) return;
    if (declaresName(node, name) || readsArguments(node)) {
      escapes = true;
      return;
    }
    if (ts.isIdentifier(node) && node.text === name && isReference(node)) {
      const read = useOf(node);
      if (read === undefined) escapes = true;
      else for (const key of read) reads.add(key);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return escapes ? undefined : reads;
}

/** The keys a pattern binds, or undefined when a rest element takes the remainder. */
function boundKeys(pattern: ts.ObjectBindingPattern): Set<string> | undefined {
  const keys = new Set<string>();
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) return undefined;
    const key = element.propertyName ?? element.name;
    const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (text === undefined) return undefined;
    keys.add(text);
  }
  return keys;
}

/** A declaration of `name` inside the body makes later uses ambiguous. */
function declaresName(node: ts.Node, name: string): boolean {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node)
  ) {
    return node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name;
  }
  return false;
}

function readsArguments(node: ts.Node): boolean {
  return ts.isIdentifier(node) && node.text === "arguments" && isReference(node);
}

/** Is this identifier a use of the value it names, rather than a name in a different namespace? */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  return true;
}

/**
 * The property names one use reads, or undefined when the use lets the whole
 * value escape. A check that the value is there reads nothing from it.
 */
function useOf(id: ts.Identifier): Set<string> | undefined {
  let node: ts.Node = id;
  while (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent)) {
    node = node.parent;
  }
  const parent = node.parent;

  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return new Set([parent.name.text]);
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const key = parent.argumentExpression;
    if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return new Set([key.text]);
    return undefined;
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return ts.isObjectBindingPattern(parent.name) ? boundKeys(parent.name) : undefined;
  }
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return new Set();
  }
  if (ts.isTypeOfExpression(parent)) return new Set();
  if (
    (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
    parent.expression === node
  ) {
    return new Set();
  }
  if (ts.isForStatement(parent) && parent.condition === node) return new Set();
  if (ts.isConditionalExpression(parent) && parent.condition === node) return new Set();
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === node ? parent.right : parent.left;
    if (NULL_CHECK_OPERATORS.has(parent.operatorToken.kind) && isNullish(other)) {
      return new Set();
    }
    if (
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.left === node
    ) {
      return new Set();
    }
  }
  return undefined;
}

function isNullish(node: ts.Expression): boolean {
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isIdentifier(node) && node.text === "undefined";
}
