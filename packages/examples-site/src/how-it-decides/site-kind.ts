import ts from "typescript";

import type { SiteKind } from "./corpus.js";

/**
 * What kind of position `site` names in `code`, read from the declaration.
 * A parameter its own function calls or constructs is a callback. Where the
 * name is declared more than once, `line` (1-based) says which.
 */
export function siteKind(code: string, site: string, line?: number): SiteKind {
  if (site === "return type") return "return";
  if (site === "this") return "this";
  const sf = ts.createSourceFile("site.ts", code, ts.ScriptTarget.Latest, true);
  const found: Array<{ kind: SiteKind; line: number }> = [];
  const visit = (node: ts.Node): void => {
    const kind = declaredKind(node, site, sf);
    if (kind) {
      const at = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push({ kind, line: at });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const chosen = found.find((d) => d.line === line) ?? found[0];
  if (!chosen) throw new Error(`the code declares no ${site}`);
  return chosen.kind;
}

function declaredKind(
  node: ts.Node,
  site: string,
  sf: ts.SourceFile,
): SiteKind | undefined {
  if (ts.isVariableDeclaration(node) && node.name.getText(sf) === site)
    return "variable";
  if (ts.isPropertyDeclaration(node) && node.name.getText(sf) === site)
    return "field";
  if (ts.isParameter(node) && node.name.getText(sf) === site) {
    const body = "body" in node.parent ? node.parent.body : undefined;
    return body && isCalledIn(body, site) ? "callback" : "parameter";
  }
  return undefined;
}

function isCalledIn(body: ts.Node, name: string): boolean {
  let called = false;
  const visit = (node: ts.Node): void => {
    if (called) return;
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      called = true;
    } else ts.forEachChild(node, visit);
  };
  visit(body);
  return called;
}
