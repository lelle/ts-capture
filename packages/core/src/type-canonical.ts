import ts from "typescript";

import { deparen, renderType, typeNode, typeText } from "./type-text.js";

// The spellings of a type-string the rest of the code compares and writes.
// Reading the string is `type-text.ts`'s; this module only chooses a spelling.

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * One canonical spelling of a type, or undefined when the text does not parse
 * as a type at all.
 */
export function canonicalTypeString(text: string): string | undefined {
  return typeText(text)?.canonical;
}

/**
 * A type-string in the punctuation TypeScript and formatters use, keeping
 * parameter names and member/union order. Applied only where a type becomes
 * text, so the gates upstream still compare the string they computed.
 * Undefined when the text is not a type, or carries a note parsing would drop.
 */
export function typeStringForSource(text: string): string | undefined {
  if (text.includes("/*")) return undefined;
  const node = typeNode(text);
  return node ? renderType(node, /*faithful*/ true) : undefined;
}

/**
 * The top-level union arms of a type-string, canonically spelled.
 *
 * From the parsed form rather than by splitting on `|`, which would cut a
 * nested union — `(A | B)[] | C` has two arms, not three.
 */
export function canonicalUnionArms(text: string): string[] | undefined {
  const node = typeNode(text);
  if (!node) return undefined;
  const top = deparen(node);
  // Each arm as it is spelled alone, so it compares equal to the same type
  // outside a union: `(() => void)` here is `() => void` there.
  return ts.isUnionTypeNode(top) ? top.types.map((t) => renderType(t)) : [renderType(top)];
}

/** Every type name this type-string refers to. */
export function typeReferenceNames(text: string): Set<string> {
  const names = new Set<string>();
  const node = typeNode(text);
  if (!node) return names;
  const walk = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) names.add(collapse(n.typeName.getText()));
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

/**
 * The leftmost identifier of every name this type-string must resolve:
 * `React` for `React.ReactElement`, `Widget` for `typeof Widget`. Undefined
 * when the text is not a type.
 */
export function rootReferenceNames(text: string): Set<string> | undefined {
  const read = typeText(text);
  return read ? new Set(read.references) : undefined;
}

/** Does this type-string spell out an object shape anywhere in it? */
export function containsTypeLiteral(text: string): boolean {
  const node = typeNode(text);
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
