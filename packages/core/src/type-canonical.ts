import ts from "typescript";

import { isParseableTypeString } from "./parseable.js";

// One spelling per type, so that comparing two type-strings answers a question
// about types rather than about punctuation.
//
// The checker's printer and ts-capture's own writer describe the same type
// differently on every axis that does not matter: the printer joins unions with
// ` | ` and object members with `; `, ts-capture uses `|` and `, `; neither
// sorts; the printer quotes no numeric key and ts-capture quotes every one. On
// nestjs/nest that mismatch let 20 annotations through the redundancy oracle
// that restate exactly what TypeScript already inferred — 11% of everything the
// run wrote.
//
// What must survive canonicalisation is everything that changes what a reader
// may do with the value: `readonly`, optionality, literal types, and which
// members exist at all.

/**
 * Parse a type-string into a TypeNode, or undefined when it is not one.
 *
 * Uses the same parseability guard the appliers use, so a string this module
 * refuses to compare is exactly a string they refuse to write. An unparseable
 * one cannot be compared as a type — the checker's printer elides a long type
 * as `... 8 more ...`, which is not a type at all.
 */
function parseType(text: string): ts.TypeNode | undefined {
  if (!isParseableTypeString(text)) return undefined;
  const sf = ts.createSourceFile(
    "__canonical_probe.ts",
    `type __X = ${text};`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
  const stmt = sf.statements[0];
  return stmt && ts.isTypeAliasDeclaration(stmt) ? stmt.type : undefined;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * A property name written the one way it can be read.
 *
 * `"3"` and `3` name the same property, and so do `"all"` and `all`. The quotes
 * stay only where dropping them would change which property is meant.
 */
function propertyName(node: ts.PropertyName): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  if (ts.isStringLiteral(node)) {
    if (/^[A-Za-z_$][\w$]*$/.test(node.text)) return node.text;
    if (/^(?:0|[1-9]\d*)$/.test(node.text)) return node.text;
    return JSON.stringify(node.text);
  }
  return collapse(node.getText());
}

/** Does this type need parentheses to sit inside a union or an array? */
function needsParens(node: ts.TypeNode): boolean {
  return (
    ts.isUnionTypeNode(node) ||
    ts.isIntersectionTypeNode(node) ||
    ts.isFunctionTypeNode(node) ||
    ts.isConstructorTypeNode(node) ||
    ts.isConditionalTypeNode(node) ||
    ts.isInferTypeNode(node)
  );
}

function deparen(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  return current;
}

/** `faithful` keeps names and order, fixing only punctuation. */
function render(node: ts.TypeNode, faithful = false): string {
  const n = deparen(node);

  if (ts.isUnionTypeNode(n)) return renderList(n.types, " | ", faithful);
  if (ts.isIntersectionTypeNode(n)) return renderList(n.types, " & ", faithful);
  if (ts.isArrayTypeNode(n)) return `${atom(n.elementType, faithful)}[]`;

  if (ts.isTypeLiteralNode(n)) {
    const members = n.members.map((m) => renderMember(m, faithful));
    if (!faithful) members.sort();
    return members.length > 0 ? `{ ${members.join("; ")} }` : "{}";
  }

  if (ts.isTypeReferenceNode(n)) {
    const name = collapse(n.typeName.getText());
    const args = n.typeArguments?.map((t) => render(t, faithful));
    return args && args.length > 0 ? `${name}<${args.join(", ")}>` : name;
  }

  if (ts.isTupleTypeNode(n)) {
    return `[${n.elements.map((t) => render(t, faithful)).join(", ")}]`;
  }

  if (ts.isFunctionTypeNode(n)) {
    // A parameter's name is not part of the type: `(a: string) => void` and
    // `(x: string) => void` are one type, and the checker's printer picks
    // whichever name the declaration used. Position replaces the name. What
    // does change which calls the type accepts — arity, `?`, `...` — is kept,
    // and the parameter's own type is canonicalised like any other.
    const params = n.parameters
      .map((param, i) => {
        const rest = param.dotDotDotToken ? "..." : "";
        const optional = param.questionToken ? "?" : "";
        const type = param.type ? render(param.type, faithful) : "any";
        const name = faithful ? collapse(param.name.getText()) : `p${i}`;
        return `${rest}${name}${optional}: ${type}`;
      })
      .join(", ");
    return `(${params}) => ${render(n.type, faithful)}`;
  }

  return collapse(n.getText());
}

/** Union/intersection arms: sorted and deduped, or as written when `faithful`. */
function renderList(nodes: ts.NodeArray<ts.TypeNode>, separator: string, faithful = false): string {
  const arms = nodes.map((n) => atom(n, faithful));
  return faithful ? arms.join(separator) : [...new Set(arms)].sort().join(separator);
}

function atom(node: ts.TypeNode, faithful = false): string {
  const n = deparen(node);
  return needsParens(n) ? `(${render(n, faithful)})` : render(n, faithful);
}

function renderMember(member: ts.TypeElement, faithful = false): string {
  if (!ts.isPropertySignature(member)) return collapse(member.getText());
  const readonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)
    ? "readonly "
    : "";
  const optional = member.questionToken ? "?" : "";
  const type = member.type ? render(member.type, faithful) : "any";
  return `${readonly}${propertyName(member.name)}${optional}: ${type}`;
}

/**
 * One canonical spelling of a type, or undefined when the text does not parse
 * as a type at all.
 */
export function canonicalTypeString(text: string): string | undefined {
  const node = parseType(text);
  return node ? render(node) : undefined;
}

/**
 * A type-string in the punctuation TypeScript and formatters use, keeping
 * parameter names and member/union order. Applied only where a type becomes
 * text, so the gates upstream still compare the string they computed.
 * Undefined when the text is not a type, or carries a note parsing would drop.
 */
export function typeStringForSource(text: string): string | undefined {
  if (text.includes("/*")) return undefined;
  const node = parseType(text);
  return node ? render(node, /*faithful*/ true) : undefined;
}

/**
 * The top-level union arms of a type-string, canonically spelled.
 *
 * From the parsed form rather than by splitting on `|`, which would cut a
 * nested union — `(A | B)[] | C` has two arms, not three.
 */
export function canonicalUnionArms(text: string): string[] | undefined {
  const node = parseType(text);
  if (!node) return undefined;
  const top = deparen(node);
  return ts.isUnionTypeNode(top) ? top.types.map((t) => atom(t)) : [render(top)];
}

/** Every type name this type-string refers to. */
export function typeReferenceNames(text: string): Set<string> {
  const names = new Set<string>();
  const node = parseType(text);
  if (!node) return names;
  const walk = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) names.add(collapse(n.typeName.getText()));
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

/** Does this type-string spell out an object shape anywhere in it? */
export function containsTypeLiteral(text: string): boolean {
  const node = parseType(text);
  if (!node) return false;
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isTypeLiteralNode(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/**
 * Do these two type-strings describe the same type?
 *
 * Falls back to exact text equality when either side cannot be parsed — the
 * checker's printer elides a long type as `... 8 more ...`, and a comparison
 * that cannot be made must not be answered with a guess.
 */
export function sameTypeString(a: string, b: string): boolean {
  const canonicalA = canonicalTypeString(a);
  if (canonicalA === undefined) return a === b;
  return canonicalA === canonicalTypeString(b);
}
