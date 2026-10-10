import ts from "typescript";

import { canonicalTypeString, typeStringForSource } from "./type-canonical.js";

// A shape the run saw at several positions in one file is one type, and an
// annotation spelling it out at each of them says so nowhere. This module
// finds the shapes a file's annotations repeat, names each after the first
// position that holds it, and rewrites the annotations to the name.

export interface ShapeSite {
  emitted: string;
  /** The identifier at the site, when it has one: a parameter or binding name. */
  name?: string;
}

export interface ShapeAlias {
  name: string;
  /** The shape in source punctuation, with the shapes it holds already named. */
  body: string;
}

export interface ShapeAliasPlan {
  /** One per site, in order: the annotation with every named shape replaced. */
  emitted: string[];
  /** Outermost shape first, in the order the sites first show them. */
  declarations: ShapeAlias[];
}

const PREFIX = "type __X = ";

/** Where a shape was found, which decides what it may be named after. */
interface Place {
  name?: string;
  /** The shape is the element of an array, so the name is the holder's singular. */
  element: boolean;
  /** The holder is a property, named after the site's own identifier only when there is none. */
  property: boolean;
}

interface Found {
  key: string;
  node: ts.TypeLiteralNode;
}

export function planShapeAliases(
  sites: readonly ShapeSite[],
  nameTaken: (name: string) => boolean,
): ShapeAliasPlan {
  const count = new Map<string, number>();
  const order: string[] = [];
  // Name sources per shape, best first: the identifier of a site holding the
  // shape itself, then of one holding an array of it, then a property.
  const sources = new Map<string, [string[], string[], string[], string[]]>();

  const note = (key: string, place: Place): void => {
    const seen = (count.get(key) ?? 0) + 1;
    count.set(key, seen);
    if (seen === 1) order.push(key);
    const slots = sources.get(key) ?? [[], [], [], []];
    sources.set(key, slots);
    if (place.name === undefined) return;
    const slot = (place.property ? 2 : 0) + (place.element ? 1 : 0);
    slots[slot].push(place.element ? singular(place.name) : place.name);
  };

  for (const site of sites) {
    if (site.emitted.includes("/*")) continue;
    const parsed = parse(site.emitted);
    if (!parsed) continue;
    visit(parsed.type, parsed.sf, { name: site.name, element: false, property: false }, note);
  }

  const alias = new Map<string, string>();
  const assigned = new Set<string>();
  for (const key of order) {
    if ((count.get(key) ?? 0) < 2) continue;
    const candidates = sources
      .get(key)!
      .flat()
      .map(identifierCase)
      .filter((n): n is string => n !== undefined);
    const name = candidates.find((n) => !assigned.has(n) && !nameTaken(n));
    if (name === undefined) continue;
    alias.set(key, name);
    assigned.add(name);
  }

  const emitted = sites.map((site) =>
    site.emitted.includes("/*") ? site.emitted : rewrite(site.emitted, alias, false),
  );
  const declarations: ShapeAlias[] = [];
  for (const key of order) {
    const name = alias.get(key);
    if (name === undefined) continue;
    const inner = rewrite(key, alias, true);
    declarations.push({ name, body: typeStringForSource(inner) ?? inner });
  }
  return { emitted, declarations };
}

function parse(text: string): { sf: ts.SourceFile; type: ts.TypeNode } | undefined {
  const sf = ts.createSourceFile(
    "__shape_alias_probe.ts",
    `${PREFIX}${text};`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
  const stmt = sf.statements[0];
  if (!stmt || !ts.isTypeAliasDeclaration(stmt) || sf.statements.length !== 1) {
    return undefined;
  }
  return { sf, type: stmt.type };
}

/**
 * Walk a type, reporting every shape worth a name with the place it sits in.
 * The place carries an identifier only where the type's own syntax gives the
 * shape one: a site's own type, a union arm of it, an array of it, or a
 * property. Inside a generic, a tuple or a function it has none.
 */
function visit(
  node: ts.TypeNode,
  sf: ts.SourceFile,
  place: Place,
  note: (key: string, place: Place) => void,
): void {
  const nowhere: Place = { element: false, property: false };
  if (ts.isParenthesizedTypeNode(node)) return visit(node.type, sf, place, note);
  if (ts.isUnionTypeNode(node)) {
    for (const arm of node.types) visit(arm, sf, place, note);
    return;
  }
  if (ts.isArrayTypeNode(node)) {
    return visit(node.elementType, sf, { ...place, element: true }, note);
  }
  if (ts.isTypeReferenceNode(node)) {
    const args = node.typeArguments ?? [];
    const isArray = ts.isIdentifier(node.typeName) && node.typeName.text === "Array";
    for (const arg of args) {
      visit(arg, sf, isArray && args.length === 1 ? { ...place, element: true } : nowhere, note);
    }
    return;
  }
  if (ts.isTypeLiteralNode(node)) {
    const key = shapeKey(node, sf);
    if (key !== undefined) note(key, place);
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const name = propertyName(member.name);
      visit(member.type, sf, { name, element: false, property: true }, note);
    }
    return;
  }
  ts.forEachChild(node, (child) => {
    if (isTypeNode(child)) visit(child, sf, nowhere, note);
  });
}

function isTypeNode(node: ts.Node): node is ts.TypeNode {
  return ts.isTypeNode(node);
}

/**
 * The canonical spelling of a shape that can be named, or undefined: a shape
 * needs at least two properties to be worth a declaration, and every member
 * must be a property with a name.
 */
function shapeKey(node: ts.TypeLiteralNode, sf: ts.SourceFile): string | undefined {
  if (node.members.length < 2) return undefined;
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.type) return undefined;
    if (propertyName(member.name) === undefined) return undefined;
  }
  return canonicalTypeString(node.getText(sf));
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/**
 * The text with every named shape replaced by its name. With `inner`, the
 * outermost shape keeps its members and only what it holds is named: that is
 * how the declaration's own body is written.
 */
function rewrite(text: string, alias: ReadonlyMap<string, string>, inner: boolean): string {
  if (alias.size === 0) return text;
  const parsed = parse(text);
  if (!parsed) return text;
  const { sf, type } = parsed;
  const found: Found[] = [];
  const collect = (node: ts.Node, top: boolean): void => {
    if (ts.isTypeLiteralNode(node) && !top) {
      const key = shapeKey(node, sf);
      if (key !== undefined && alias.has(key)) {
        found.push({ key, node });
        return;
      }
    }
    ts.forEachChild(node, (child) => collect(child, false));
  };
  collect(type, inner);
  let out = text;
  for (const { key, node } of found.sort((a, b) => b.node.pos - a.node.pos)) {
    const start = node.getStart(sf) - PREFIX.length;
    const end = node.getEnd() - PREFIX.length;
    out = out.slice(0, start) + alias.get(key)! + out.slice(end);
  }
  return out;
}

/** `_product` and `$item` are `Product` and `Item`; anything else than an identifier is nothing. */
function identifierCase(name: string): string | undefined {
  const bare = name.replace(/^[_$]+/, "");
  if (!/^[A-Za-z][\w$]*$/.test(bare)) return undefined;
  return bare[0].toUpperCase() + bare.slice(1);
}

/** The singular an English plural most often has; a name a reader can rename. */
function singular(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (["sses", "xes", "ches", "shes"].some((ending) => name.endsWith(ending))) {
    return name.slice(0, -2);
  }
  if (name.endsWith("ss") || !name.endsWith("s")) return name;
  return name.slice(0, -1);
}
