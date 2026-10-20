import ts from "typescript";

import { isParseableTypeString } from "./parseable.js";

// The one reading of a type-string. Every module that needs to know what a
// type-string says — its canonical spelling, its union arms, the names it needs
// in scope, whether it is a literal — asks here, so two modules cannot read the
// same string two ways.

export interface TypeText {
  /** The text as given. */
  readonly source: string;
  /** One spelling per type: union arms sorted, members sorted, punctuation fixed. */
  readonly canonical: string;
  /** The top-level union arms as written, each a type of its own; a non-union is its own arm. */
  readonly arms: readonly TypeText[];
  /** The leftmost identifier of every name the type must resolve: `React` for `React.FC`, `W` for `typeof W`. */
  readonly references: ReadonlySet<string>;
  /** A single literal type: `"a"`, `42`, `-1`, `true`. */
  readonly literal: boolean;
}

const PREFIX = "type __X = ";

interface Parsed {
  sf: ts.SourceFile;
  node: ts.TypeNode;
}

// Observed strings repeat across a run; a parse each time would be most of the cost.
const MAX_CACHED = 10_000;
const cache = new Map<string, TypeText | null>();

/** Read a type-string, or undefined when it is not a type (`... 8 more ...` is not one). */
export function typeText(text: string): TypeText | undefined {
  const hit = cache.get(text);
  if (hit !== undefined) return hit ?? undefined;
  if (cache.size >= MAX_CACHED) cache.clear();
  const parsed = parse(text);
  const read = parsed ? reading(text, parsed) : null;
  cache.set(text, read);
  return read ?? undefined;
}

/** The parsed node, for the canonicaliser's other spellings. */
export function typeNode(text: string): ts.TypeNode | undefined {
  return parse(text)?.node;
}

/**
 * The top-level union arms of a type-string, as written. Text that is not a
 * type is split at the `|` outside brackets, quotes and comments.
 */
export function unionArms(text: string): string[] {
  const read = typeText(text.trim());
  return read ? read.arms.map((arm) => arm.source) : splitOutside(text);
}

function parse(text: string): Parsed | undefined {
  if (!isParseableTypeString(text)) return undefined;
  const sf = ts.createSourceFile(
    "__type_text.ts",
    `${PREFIX}${text};`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
  const stmt = sf.statements[0];
  return stmt && ts.isTypeAliasDeclaration(stmt) ? { sf, node: stmt.type } : undefined;
}

function reading(text: string, { sf, node }: Parsed): TypeText {
  let canonical: string | undefined;
  let arms: TypeText[] | undefined;
  let references: Set<string> | undefined;
  let literal: boolean | undefined;
  const self: TypeText = {
    source: text,
    get canonical() {
      return (canonical ??= renderType(node));
    },
    get arms() {
      return (arms ??= armsOf(text, sf, node, self));
    },
    get references() {
      return (references ??= rootNames(node));
    },
    get literal() {
      return (literal ??= isLiteral(deparen(node)));
    },
  };
  return self;
}

/**
 * From the union node itself, so a nested union stays whole — `(A | B)[] | C` has
 * two arms. Each arm runs to the `|` that ends it, so a comment after it (the
 * class-chain marker `Cat /* @sa:Mammal|Animal *\/`) stays with it.
 */
function armsOf(text: string, sf: ts.SourceFile, node: ts.TypeNode, self: TypeText): TypeText[] {
  const end = PREFIX.length + text.length;
  if (!ts.isUnionTypeNode(node)) {
    const trimmed = text.trim();
    return [trimmed === text ? self : typeText(trimmed)!];
  }
  const members = node.types;
  return members.map((member, i) => {
    const next = members[i + 1];
    // `pos` of the next arm is just past the `|` before it.
    const source = sf.text.slice(member.getStart(sf), next ? next.pos - 1 : end).trim();
    return typeText(source)!;
  });
}

function rootNames(node: ts.TypeNode): Set<string> {
  const names = new Set<string>();
  const root = (name: ts.EntityName): string => {
    let left = name;
    while (ts.isQualifiedName(left)) left = left.left;
    return left.text;
  };
  const walk = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) names.add(root(n.typeName));
    else if (ts.isTypeQueryNode(n)) names.add(root(n.exprName));
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

function isLiteral(node: ts.TypeNode): boolean {
  if (!ts.isLiteralTypeNode(node)) return false;
  const { literal } = node;
  return (
    ts.isStringLiteral(literal) ||
    ts.isNoSubstitutionTemplateLiteral(literal) ||
    ts.isNumericLiteral(literal) ||
    (ts.isPrefixUnaryExpression(literal) &&
      literal.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(literal.operand)) ||
    literal.kind === ts.SyntaxKind.TrueKeyword ||
    literal.kind === ts.SyntaxKind.FalseKeyword
  );
}

function splitOutside(text: string): string[] {
  const arms: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = closing(text, i, c);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
    // The `>` of a function type's `=>` closes nothing.
    else if (c === ")" || c === "}" || c === "]" || (c === ">" && text[i - 1] !== "=")) depth--;
    else if (c === "|" && depth === 0) {
      arms.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  arms.push(text.slice(start).trim());
  return arms.filter((arm) => arm.length > 0);
}

function closing(text: string, open: number, quote: string): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

// --- The canonical writer ---
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

export function deparen(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  return current;
}

/** `faithful` keeps names and order, fixing only punctuation. */
export function renderType(node: ts.TypeNode, faithful = false): string {
  const n = deparen(node);

  if (ts.isUnionTypeNode(n)) return renderList(n.types, " | ", faithful);
  if (ts.isIntersectionTypeNode(n)) return renderList(n.types, " & ", faithful);
  if (ts.isArrayTypeNode(n)) return `${renderAtom(n.elementType, faithful)}[]`;

  if (ts.isTypeLiteralNode(n)) {
    const members = n.members.map((m) => renderMember(m, faithful));
    if (!faithful) members.sort();
    return members.length > 0 ? `{ ${members.join("; ")} }` : "{}";
  }

  if (ts.isTypeReferenceNode(n)) {
    const name = collapse(n.typeName.getText());
    // Observation spells a mixed array `Array<A | B>`; in source it is written
    // `(A | B)[]`, the form the applier already uses for `T[]`, and the two
    // are one type to compare.
    if (name === "Array" && n.typeArguments?.length === 1) {
      return `${renderAtom(n.typeArguments[0], faithful)}[]`;
    }
    const args = n.typeArguments?.map((t) => renderType(t, faithful));
    return args && args.length > 0 ? `${name}<${args.join(", ")}>` : name;
  }

  if (ts.isTupleTypeNode(n)) {
    return `[${n.elements.map((t) => renderType(t, faithful)).join(", ")}]`;
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
        const type = param.type ? renderType(param.type, faithful) : "any";
        const name = faithful ? collapse(param.name.getText()) : `p${i}`;
        return `${rest}${name}${optional}: ${type}`;
      })
      .join(", ");
    return `(${params}) => ${renderType(n.type, faithful)}`;
  }

  return collapse(n.getText());
}

/**
 * Union/intersection arms: sorted and deduped, or as written when `faithful`,
 * except that a union's `null` and `undefined` go last. The canonical sort
 * puts them first, and `null | string` is not how anyone writes it.
 */
function renderList(nodes: ts.NodeArray<ts.TypeNode>, separator: string, faithful = false): string {
  const arms = nodes.map((n) => renderAtom(n, faithful));
  if (!faithful) return [...new Set(arms)].sort().join(separator);
  return separator === " | " ? nullishLast(arms).join(separator) : arms.join(separator);
}

const NULLISH_RANK: Record<string, number> = { null: 1, undefined: 2 };

function nullishLast(arms: readonly string[]): string[] {
  const rank = (arm: string): number => NULLISH_RANK[arm] ?? 0;
  return [...arms].sort((a, b) => rank(a) - rank(b));
}

function renderAtom(node: ts.TypeNode, faithful = false): string {
  const n = deparen(node);
  return needsParens(n) ? `(${renderType(n, faithful)})` : renderType(n, faithful);
}

function renderMember(member: ts.TypeElement, faithful = false): string {
  // The parser keeps a member's trailing `,` or `;` inside the node.
  if (!ts.isPropertySignature(member)) return collapse(member.getText()).replace(/[,;]$/, "");
  const readonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)
    ? "readonly "
    : "";
  const optional = member.questionToken ? "?" : "";
  const type = member.type ? renderType(member.type, faithful) : "any";
  return `${readonly}${propertyName(member.name)}${optional}: ${type}`;
}
