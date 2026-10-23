import ts from "typescript";

import type { SiteKind } from "./corpus.js";

/**
 * What kind of position `site` names in `code`, read from the declaration.
 * A parameter its own function calls or constructs is a callback.
 */
export function siteKind(code: string, site: string): SiteKind {
  if (site === "return type") return "return";
  if (site === "this") return "this";
  const sf = ts.createSourceFile("site.ts", code, ts.ScriptTarget.Latest, true);
  let kind: SiteKind | undefined;
  const visit = (node: ts.Node): void => {
    if (kind) return;
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === site)
      kind = "variable";
    else if (ts.isPropertyDeclaration(node) && node.name.getText(sf) === site)
      kind = "field";
    else if (ts.isParameter(node) && node.name.getText(sf) === site) {
      const body = "body" in node.parent ? node.parent.body : undefined;
      kind = body && isCalledIn(body, site) ? "callback" : "parameter";
    } else ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!kind) throw new Error(`the code declares no ${site}`);
  return kind;
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
