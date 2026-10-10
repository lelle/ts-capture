import ts from "typescript";
import { expect } from "vitest";

import type { Applied } from "./applied.js";

import { canonicalTypeString } from "../type-canonical.js";

// Two questions a spec asks of an applied file, kept apart on purpose. What
// was written is a question about the AST: the annotation's node, its name
// if it is a reference, or its absence. What it means is a question for the
// checker, which sees through every alias. A test that asks one and reads
// the answer to the other proves the wrong thing.

/** A position in the output: a declaration by name, or a function's return. */
export type Site = string | { returnOf: string };

interface AppliedMatchers<R = unknown> {
  /** The annotation written at the site, as a canonical shape or a reference by name. */
  toAnnotate(site: Site, expected: string | { ref: string }): R;
  /** No annotation at the site. */
  toLeaveUntyped(site: Site): R;
  /** The type TypeScript has at the site, canonically, aliases expanded. */
  toTypeAs(site: Site, expected: string): R;
  /** A type alias in the output, by name and canonical body. */
  toDeclareAlias(name: string, body: string): R;
  /** No diagnostic the input did not already have. */
  toHaveNoNewDiagnostics(): R;
}

declare module "vitest" {
  // The parameter must match vitest's own declaration, which defaults to any.
  interface Assertion<T = any> extends AppliedMatchers<T> {}
  interface AsymmetricMatchersContaining extends AppliedMatchers {}
}

type Result = { pass: boolean; message: () => string };

export function describeDiagnostic(d: ts.Diagnostic): string {
  return `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
}

const siteName = (site: Site): string =>
  typeof site === "string" ? site : `${site.returnOf} return`;

function findSite(out: Applied, site: Site): ts.NamedDeclaration | ts.SignatureDeclaration {
  const wanted = typeof site === "string" ? site : site.returnOf;
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (typeof site === "string") {
      if (
        isNamedSite(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === wanted
      ) {
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

function isNamedSite(node: ts.Node): node is ts.NamedDeclaration {
  return (
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isBindingElement(node)
  );
}

function functionName(fn: ts.SignatureDeclaration): string | undefined {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

function annotationNode(out: Applied, site: Site): ts.TypeNode | undefined {
  const node = findSite(out, site);
  return (node as { type?: ts.TypeNode }).type;
}

function typeAtSite(out: Applied, site: Site): ts.Type {
  const node = findSite(out, site);
  if (typeof site === "string")
    return out.checker.getTypeAtLocation((node as ts.NamedDeclaration).name!);
  const signature = out.checker.getSignatureFromDeclaration(node as ts.SignatureDeclaration);
  if (!signature) throw new Error(`no signature for ${siteName(site)}`);
  return signature.getReturnType();
}

const canonical = (text: string): string => canonicalTypeString(text) ?? text.trim();

const matchers = {
  toAnnotate(out: Applied, site: Site, expected: string | { ref: string }): Result {
    const node = annotationNode(out, site);
    const written = node?.getText(out.sf);
    if (typeof expected === "string") {
      const pass = written !== undefined && canonical(written) === canonical(expected);
      return {
        pass,
        message: () =>
          `expected ${siteName(site)} ${pass ? "not " : ""}to be annotated ${canonical(expected)}, ` +
          (written === undefined
            ? "but it has no annotation"
            : `but it is annotated ${canonical(written)}`),
      };
    }
    const pass =
      node !== undefined &&
      ts.isTypeReferenceNode(node) &&
      node.typeName.getText(out.sf) === expected.ref;
    return {
      pass,
      message: () =>
        `expected ${siteName(site)} ${pass ? "not " : ""}to refer to ${expected.ref}, ` +
        (written === undefined ? "but it has no annotation" : `but it is annotated ${written}`),
    };
  },

  toLeaveUntyped(out: Applied, site: Site): Result {
    const written = annotationNode(out, site)?.getText(out.sf);
    const pass = written === undefined;
    return {
      pass,
      message: () =>
        pass
          ? `expected ${siteName(site)} to be annotated, but it is not`
          : `expected ${siteName(site)} to be left untyped, but it is annotated ${canonical(written)}`,
    };
  },

  toTypeAs(out: Applied, site: Site, expected: string): Result {
    const type = typeAtSite(out, site);
    const has = out.checker.typeToString(
      type,
      undefined,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
    );
    const pass = canonical(has) === canonical(expected);
    return {
      pass,
      message: () =>
        `expected the type of ${siteName(site)} ${pass ? "not " : ""}to be ${canonical(expected)}, ` +
        `but TypeScript has ${canonical(has)}`,
    };
  },

  toDeclareAlias(out: Applied, name: string, body: string): Result {
    const alias = out.sf.statements.find(
      (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name,
    );
    if (!alias) {
      return { pass: false, message: () => `no alias named ${name} in:\n${out.text}` };
    }
    const has = alias.type.getText(out.sf);
    const pass = canonical(has) === canonical(body);
    return {
      pass,
      message: () =>
        `expected type ${name} ${pass ? "not " : ""}to be ${canonical(body)}, but it is ${canonical(has)}`,
    };
  },

  toHaveNoNewDiagnostics(out: Applied): Result {
    const pass = out.newDiagnostics.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? "expected new diagnostics, but the output has none the input did not have"
          : `the output has diagnostics the input did not:\n  ${out.newDiagnostics.map(describeDiagnostic).join("\n  ")}`,
    };
  },
};

expect.extend(matchers);
