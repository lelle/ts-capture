import ts from "typescript";
import { expect } from "vitest";

import type { ExtraOptions } from "../type-collector.js";

import { findInstrumentationSite } from "../instrumentation-site-spec.js";
import { canonicalTypeString, sameTypeString } from "../type-canonical.js";
import { type Applied, nodesOf, printedAst } from "./applied.js";
import { callText, type Instrumented, type Observed, type TrackedCall } from "./instrumented.js";
import { callFormOf, isRuntimeDeclaration } from "./strip-instrumentation.js";

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
  /** A type-string, or a list of them, naming the same type(s) in any spelling. */
  toBeTheType(expected: string | string[]): R;
}

// The same split for an instrumented file. What was instrumented is a
// question about the calls in the output; what running it observes is a
// question for the sandbox. Neither is a question about how a call is spelled.

/** The options a call must carry, as a subset, and `in` for the file it names. */
export type TrackedWith = Partial<ExtraOptions> & { in?: string };

interface InstrumentedMatchers<R = unknown> {
  /** A parameter call that records the name. */
  toTrack(name: string, expected?: TrackedWith): R;
  /** No call records the name, by name or at the offset of its declaration. */
  toLeaveUntracked(name: string): R;
  /** The value a function returns is recorded, by the function's name. */
  toWrapReturnOf(fn: string, expected?: TrackedWith): R;
  /** The initializer of a variable or class field is recorded, by the declared name. */
  toWrapInitializerOf(name: string, expected?: TrackedWith): R;
  /** A call argument is tracked, by its text. */
  toTrackArgument(text: string): R;
  /** The output declares `__tscptr__`. */
  toDeclareRuntime(): R;
  /** No call, and the program of the input. */
  toLeaveUnchanged(): R;
  /** The type(s) recorded at a site of the input when the output ran, as one union. */
  toObserve(site: Site, expected: string): R;
}

declare module "vitest" {
  // The parameter must match vitest's own declaration, which defaults to any.
  interface Assertion<T = any> extends AppliedMatchers<T>, InstrumentedMatchers<T> {}
  interface AsymmetricMatchersContaining extends AppliedMatchers, InstrumentedMatchers {}
}

type Result = { pass: boolean; message: () => string };

export function describeDiagnostic(d: ts.Diagnostic): string {
  return `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
}

const siteName = (site: Site): string =>
  typeof site === "string" ? site : `${site.returnOf} return`;

function findSite(
  out: Pick<Applied, "sf" | "text">,
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
function isNamedSite(node: ts.Node): node is ts.NamedDeclaration {
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

function annotationNode(out: Applied, site: Site): ts.TypeNode | undefined {
  // A `this` parameter exists only when something wrote it, so its absence is
  // the untyped case rather than a missing site.
  if (
    site === "this" &&
    !nodesOf(out, ts.isParameter).some((p) => p.name.getText(out.sf) === "this")
  ) {
    return undefined;
  }
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
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const PRINT_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;

/**
 * The type spelled out by its members, one level deep. The checker prints an
 * interface or a class instance by name, and a spec asking about shape wants
 * the shape, whatever declared it. Unions are rendered arm by arm; anything
 * with signatures or index signatures is left to the printer.
 */
function structureOf(checker: ts.TypeChecker, type: ts.Type): string {
  if (type.isUnion()) return type.types.map((arm) => structureOf(checker, arm)).join(" | ");
  const print = (t: ts.Type): string => checker.typeToString(t, undefined, PRINT_FLAGS);
  if (!(type.flags & ts.TypeFlags.Object)) return print(type);
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return print(type);
  if (checker.getIndexInfosOfType(type).length > 0) return print(type);
  if (checker.isArrayType(type) || checker.isTupleType(type)) return print(type);
  const members = type.getProperties().map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const propertyType = declaration
      ? checker.getTypeOfSymbolAtLocation(property, declaration)
      : checker.getTypeOfSymbol(property);
    const optional = property.flags & ts.SymbolFlags.Optional ? "?" : "";
    const readonly =
      declaration &&
      ts.canHaveModifiers(declaration) &&
      ts.getModifiers(declaration)?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)
        ? "readonly "
        : "";
    // An optional property's type carries `undefined` for the absence; `?` says it.
    const text = print(
      optional && propertyType.isUnion() ? checker.getNonNullableType(propertyType) : propertyType,
    );
    return `${readonly}${property.name}${optional}: ${text}`;
  });
  return members.length > 0 ? `{ ${members.join("; ")} }` : "{}";
}

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
    const printed = out.checker.typeToString(type, undefined, PRINT_FLAGS);
    const structural = structureOf(out.checker, type);
    const pass = [printed, structural].some((has) => canonical(has) === canonical(expected));
    return {
      pass,
      message: () =>
        `expected the type of ${siteName(site)} ${pass ? "not " : ""}to be ${canonical(expected)}, ` +
        `but TypeScript has ${canonical(printed)}` +
        (structural === printed ? "" : `, which is ${canonical(structural)}`),
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

  toBeTheType(received: unknown, expected: string | string[]): Result {
    const want = Array.isArray(expected) ? expected : [expected];
    const got = Array.isArray(received) ? received : [received];
    const describe = (list: unknown[]): string =>
      list.map((t) => (typeof t === "string" ? canonical(t) : String(t))).join(", ");
    const pass =
      got.length === want.length &&
      got.every((t, i) => typeof t === "string" && sameTypeString(t, want[i]!));
    return {
      pass,
      message: () =>
        got.length === want.length
          ? `expected ${describe(got)} ${pass ? "not " : ""}to be the type ${describe(want)}`
          : `expected ${want.length} types, ${describe(want)}, but got ${got.length}: ${describe(got)}`,
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

function matchingProblem(call: TrackedCall, expected: TrackedWith): string | undefined {
  const { in: filename, ...options } = expected;
  if (filename !== undefined && call.filename !== filename) {
    return `in ${filename}, but it is recorded in ${call.filename}`;
  }
  const has = call.options as Record<string, unknown>;
  const differing = Object.entries(options).filter(
    ([key, value]) => JSON.stringify(has[key]) !== JSON.stringify(value),
  );
  if (differing.length === 0) return undefined;
  return `with ${JSON.stringify(options)}, but it is recorded with ${JSON.stringify(call.options)}`;
}

/** The outcome of looking for one call among candidates that are about the right thing. */
function foundAmong(
  candidates: TrackedCall[],
  expected: TrackedWith,
  what: string,
  otherwise: string,
): Result {
  const problems = candidates.map((call) => matchingProblem(call, expected));
  const pass = problems.some((problem) => problem === undefined);
  return {
    pass,
    message: () => {
      if (pass) {
        const call = candidates[problems.indexOf(undefined)]!;
        return `expected ${what} not to be recorded, but ${callText(call)} records it`;
      }
      if (candidates.length === 0) return `expected ${what} to be ${otherwise}`;
      return `expected ${what} to be recorded ${problems[0]}`;
    },
  };
}

const isRuntimeCall = (node: ts.Node): boolean => callFormOf(node) !== undefined;

/** The name of the function a node is directly in, through the calls that wrap an arrow. */
function enclosingFunctionName(node: ts.Node): string | undefined {
  let fn: ts.Node | undefined = node.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return undefined;
  if (fn.name) return fn.name.getText();
  let holder: ts.Node = fn.parent;
  while (ts.isParenthesizedExpression(holder) || isRuntimeCall(holder)) holder = holder.parent;
  if (
    ts.isVariableDeclaration(holder) ||
    ts.isPropertyDeclaration(holder) ||
    ts.isPropertyAssignment(holder)
  ) {
    return holder.name.getText();
  }
  return undefined;
}

const list = (names: Array<string | undefined>): string => {
  const known = [...new Set(names.filter((name) => name !== undefined))];
  return known.length > 0 ? known.join(", ") : "nothing";
};

/** The offsets at which the input declares `name`, where an observation of it would be keyed. */
function declarationOffsets(input: string, filename: string, name: string): Set<number> {
  const sf = ts.createSourceFile(filename, input, ts.ScriptTarget.Latest, true);
  const offsets = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (isNamedSite(node) && node.name && node.name.getText(sf) === name) {
      const optional = ts.isParameter(node) && node.questionToken ? 1 : 0;
      offsets.add(node.name.getEnd() + optional);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offsets;
}

const recordsADeclaration = (call: TrackedCall): boolean =>
  call.form === "param" ||
  (call.form === "ret" && (call.options.varDecl === true || call.options.paramReturn === true));

const instrumentedMatchers = {
  toTrack(out: Instrumented, name: string, expected: TrackedWith = {}): Result {
    const parameters = out.calls.filter((call) => call.form === "param");
    const named = parameters.filter((call) => call.name === name);
    return foundAmong(
      named,
      expected,
      name,
      `tracked, but no __tscptr__ call records it; tracked: ${list(parameters.map((c) => c.name))}`,
    );
  },

  toLeaveUntracked(out: Instrumented, name: string): Result {
    const offsets =
      out.input === undefined
        ? new Set<number>()
        : declarationOffsets(out.input, out.filename, name);
    const recording = out.calls.find(
      (call) =>
        (call.form === "param" && call.name === name) ||
        (recordsADeclaration(call) && call.name !== "this" && offsets.has(call.pos)),
    );
    return {
      pass: recording === undefined,
      message: () =>
        recording === undefined
          ? `expected ${name} to be tracked, but no __tscptr__ call records it`
          : `expected ${name} to be left untracked, but ${callText(recording)} records it`,
    };
  },

  toWrapReturnOf(out: Instrumented, fn: string, expected: TrackedWith = {}): Result {
    const returns = out.calls.filter((call) => call.form === "ret" && call.options.returnType);
    const names = returns.map((call) => enclosingFunctionName(call.node));
    return foundAmong(
      returns.filter((_, i) => names[i] === fn),
      expected,
      `the return of ${fn}`,
      `recorded, but no __tscptr__.ret call wraps it; wrapped returns: ${list(names)}`,
    );
  },

  toWrapInitializerOf(out: Instrumented, name: string, expected: TrackedWith = {}): Result {
    const declared = (call: TrackedCall): string | undefined => {
      const holder = call.node.parent;
      return ts.isVariableDeclaration(holder) || ts.isPropertyDeclaration(holder)
        ? holder.name.getText()
        : undefined;
    };
    const initializers = out.calls.filter(
      (call) => call.form === "ret" && call.options.varDecl && declared(call) !== undefined,
    );
    return foundAmong(
      initializers.filter((call) => declared(call) === name),
      expected,
      `the initializer of ${name}`,
      `recorded, but no __tscptr__.ret call wraps it; wrapped initializers: ${list(initializers.map(declared))}`,
    );
  },

  toTrackArgument(out: Instrumented, text: string): Result {
    const tracked = out.calls.filter((call) => call.form === "track");
    return foundAmong(
      tracked.filter((call) => call.valueText === collapse(text)),
      {},
      `the argument ${text}`,
      `tracked, but no __tscptr__.track call wraps it; tracked arguments: ${list(tracked.map((c) => c.valueText))}`,
    );
  },

  toDeclareRuntime(out: Instrumented): Result {
    const pass = out.sf.statements.some(
      (statement) => ts.isFunctionDeclaration(statement) && isRuntimeDeclaration(statement),
    );
    return {
      pass,
      message: () =>
        `expected the output ${pass ? "not " : ""}to declare __tscptr__, but it ${pass ? "does" : "does not"}:\n${out.text}`,
    };
  },

  toLeaveUnchanged(out: Instrumented): Result {
    if (out.input === undefined) throw new Error("toLeaveUnchanged needs the input of the output");
    const [call] = out.calls;
    const same = printedAst(out.text) === printedAst(out.input);
    return {
      pass: call === undefined && same,
      message: () => {
        if (call) return `expected the input to be left unchanged, but ${callText(call)} was added`;
        if (!same)
          return `expected the input to be left unchanged, but the output is:\n${out.text}`;
        return "expected the input to be instrumented, but the output has no __tscptr__ call";
      },
    };
  },

  toObserve(observed: Observed, site: Site, expected: string): Result {
    if (observed.input === undefined) throw new Error("toObserve needs the input of the output");
    const sf = ts.createSourceFile(observed.filename, observed.input, ts.ScriptTarget.Latest, true);
    const node = findSite({ sf, text: observed.input }, site);
    const isReturn = typeof site !== "string";
    const pos = isReturn
      ? findInstrumentationSite(node, "return", sf)?.pos
      : (node as ts.NamedDeclaration).name!.getEnd() +
        (ts.isParameter(node) && node.questionToken ? 1 : 0);
    const types = observed.entries
      .filter(
        ([, offset, , options]) =>
          offset === pos && Boolean(options.returnType) === isReturn && !options.paramReturn,
      )
      .flatMap(([, , discovered]) => discovered.map(([type]) => type ?? "undefined"));
    const union = [...new Set(types)].join(" | ");
    const pass = types.length > 0 && sameTypeString(union, expected);
    return {
      pass,
      message: () =>
        types.length === 0
          ? `expected ${siteName(site)} to observe ${canonical(expected)}, but nothing was observed at ${siteName(site)}`
          : `expected ${siteName(site)} ${pass ? "not " : ""}to observe ${canonical(expected)}, but it observed ${canonical(union)}`,
    };
  },
};

expect.extend(matchers);
expect.extend(instrumentedMatchers);
