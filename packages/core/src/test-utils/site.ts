import ts from "typescript";

// Where a spec points: a declaration by the name it is written under, or a
// function's return. Both matcher families find their node the same way.

/** A position in the output: a declaration by name, or a function's return. */
export type Site = string | { returnOf: string };

export type MatcherResult = { pass: boolean; message: () => string };

export const siteName = (site: Site): string =>
  typeof site === "string" ? site : `${site.returnOf} return`;

export const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

export function findSite(
  out: { sf: ts.SourceFile; text: string },
  site: Site,
): ts.NamedDeclaration | ts.SignatureDeclaration {
  const wanted = typeof site === "string" ? site : site.returnOf;
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (typeof site === "string") {
      // A destructured site is named by its pattern as written: `{ a, b }`.
      if (isNamedSite(node) && node.name && collapse(node.name.getText(out.sf)) === wanted) {
        found = node;
        return;
      }
    } else if (ts.isFunctionLike(node) && functionName(node) === wanted) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(out.sf);
  if (!found) throw new Error(`no site named ${siteName(site)} in:\n${out.text}`);
  return found as ts.NamedDeclaration | ts.SignatureDeclaration;
}

// A parameter of a function type, `cb: (p: unknown) => void`, is a node named
// `p` too, but nothing is written at it and it has no value.
export function isNamedSite(node: ts.Node): node is ts.NamedDeclaration {
  return (
    (ts.isParameter(node) && hasBody(node.parent)) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isBindingElement(node)
  );
}

function hasBody(fn: ts.Node): fn is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(fn) ||
    ts.isFunctionExpression(fn) ||
    ts.isArrowFunction(fn) ||
    ts.isMethodDeclaration(fn) ||
    ts.isConstructorDeclaration(fn) ||
    ts.isGetAccessorDeclaration(fn) ||
    ts.isSetAccessorDeclaration(fn)
  );
}

function functionName(fn: ts.SignatureDeclaration): string | undefined {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}
