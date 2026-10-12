import ts from "typescript";
import { expect } from "vitest";

import type { ExtraOptions } from "../type-collector.js";

import { findInstrumentationSite } from "../instrumentation-site-spec.js";
import { canonicalTypeString, sameTypeString } from "../type-canonical.js";
import { callText, type Instrumented, type Observed, type TrackedCall } from "./instrumented.js";
import {
  collapse,
  findSite,
  isNamedSite,
  type MatcherResult as Result,
  type Site,
  siteName,
} from "./site.js";
import { callFormOf, isRuntimeDeclaration, namedValue, tokensOf } from "./strip-instrumentation.js";

// What was instrumented is a question about the calls in the output, not
// about how a call is spelled.

/**
 * The options a call must carry, as a subset, with `in` for the file it names
 * and `at` for the offset it records at.
 */
export type TrackedWith = Partial<ExtraOptions> & { in?: string; at?: number };

interface InstrumentedMatchers<R = unknown> {
  /** A parameter call that records the name. */
  toTrack(name: string, expected?: TrackedWith): R;
  /** No call records the name, by name or at the offset of its declaration. */
  toLeaveUntracked(name: string): R;
  /** The value a function returns is recorded, by the function's name. */
  toWrapReturnOf(fn: string, expected?: TrackedWith): R;
  /** The initializer of a variable or class field is recorded, by the declared name. */
  toWrapInitializerOf(name: string, expected?: TrackedWith): R;
  /** The value a callback parameter returns when the function calls it is recorded. */
  toWrapCallsOf(parameter: string, expected?: TrackedWith): R;
  /** A function declaration is registered, by its name. */
  toRegisterFunction(name: string, expected?: TrackedWith): R;
  /** A call argument is tracked, by its text. */
  toTrackArgument(text: string): R;
  /** The output declares `__tscptr__`, and the member of its namespace when one is named. */
  toDeclareRuntime(member?: string): R;
  /** No call, and the program of the input. */
  toLeaveUnchanged(): R;
  /** The type(s) recorded at a site of the input when the output ran, as one union. */
  toObserve(site: Site, expected: string): R;
}

declare module "vitest" {
  // The parameter must match vitest's own declaration, which defaults to any.
  interface Assertion<T = any> extends InstrumentedMatchers<T> {}
  interface AsymmetricMatchersContaining extends InstrumentedMatchers {}
}

function matchingProblem(call: TrackedCall, expected: TrackedWith): string | undefined {
  const { in: filename, at, ...options } = expected;
  if (filename !== undefined && call.filename !== filename) {
    return `in ${filename}, but it is recorded in ${call.filename}`;
  }
  if (at !== undefined && call.pos !== at) return `at ${at}, but it is recorded at ${call.pos}`;
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

const canonical = (text: string): string => canonicalTypeString(text) ?? text.trim();

const isRuntimeCall = (node: ts.Node): boolean => callFormOf(node) !== undefined;

/** The `({ "f": fn })["f"]` a property assignment is the inside of, if it is one. */
function namingWrapAround(node: ts.Node): ts.ElementAccessExpression | undefined {
  if (!ts.isPropertyAssignment(node)) return undefined;
  const object = node.parent;
  const wrap = ts.isParenthesizedExpression(object.parent) ? object.parent.parent : object.parent;
  return wrap && namedValue(wrap) === node.initializer
    ? (wrap as ts.ElementAccessExpression)
    : undefined;
}

/** The name of the function a node is directly in, through the calls that wrap an arrow. */
function enclosingFunctionName(node: ts.Node): string | undefined {
  let fn: ts.Node | undefined = node.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return undefined;
  if (fn.name) return fn.name.getText();
  let holder: ts.Node = fn.parent;
  for (;;) {
    const wrap = namingWrapAround(holder);
    if (wrap) holder = wrap.parent;
    else if (ts.isParenthesizedExpression(holder) || isRuntimeCall(holder)) holder = holder.parent;
    else break;
  }
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

const recordsAName = (call: TrackedCall): boolean =>
  call.form === "param" || call.form === "bundle";

const recordsADeclaration = (call: TrackedCall): boolean =>
  call.form === "param" ||
  (call.form === "ret" && (call.options.varDecl === true || call.options.paramReturn === true));

const instrumentedMatchers = {
  toTrack(out: Instrumented, name: string, expected: TrackedWith = {}): Result {
    const parameters = out.calls.filter(recordsAName);
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
        (recordsAName(call) && call.name === name) ||
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

  toWrapCallsOf(out: Instrumented, parameter: string, expected: TrackedWith = {}): Result {
    const callbacks = out.calls.filter((call) => call.form === "ret" && call.options.paramReturn);
    return foundAmong(
      callbacks.filter((call) => call.options.paramReturnMember === parameter),
      expected,
      `what ${parameter} returns`,
      `recorded, but no __tscptr__.ret call wraps a call of it; wrapped callbacks: ${list(callbacks.map((c) => c.options.paramReturnMember))}`,
    );
  },

  toRegisterFunction(out: Instrumented, name: string, expected: TrackedWith = {}): Result {
    const registered = out.calls.filter((call) => call.form === "registerFn");
    return foundAmong(
      registered.filter((call) => call.valueText === name),
      expected,
      `the function ${name}`,
      `registered, but no __tscptr__.registerFn call names it; registered: ${list(registered.map((c) => c.valueText))}`,
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

  toDeclareRuntime(out: Instrumented, member?: string): Result {
    const declarations = out.sf.statements.filter(isRuntimeDeclaration);
    const members = declarations
      .filter(ts.isModuleDeclaration)
      .flatMap((namespace) =>
        namespace.body && ts.isModuleBlock(namespace.body) ? namespace.body.statements : [],
      )
      .filter(ts.isFunctionDeclaration)
      .map((declared) => declared.name?.text);
    const pass =
      member === undefined ? declarations.some(ts.isFunctionDeclaration) : members.includes(member);
    const what = member === undefined ? "__tscptr__" : `__tscptr__.${member}`;
    return {
      pass,
      message: () =>
        `expected the output ${pass ? "not " : ""}to declare ${what}, but it ${pass ? "does" : "does not"}` +
        (declarations.length > 0 ? `; it declares ${list(members)}` : ""),
    };
  },

  toLeaveUnchanged(out: Instrumented): Result {
    if (out.input === undefined) throw new Error("toLeaveUnchanged needs the input of the output");
    const [call] = out.calls;
    const same = tokensOf(out.text, out.filename) === tokensOf(out.input, out.filename);
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

expect.extend(instrumentedMatchers);
