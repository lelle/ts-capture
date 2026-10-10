import vm from "node:vm";
import ts from "typescript";

import type { LiteralOptions } from "../collector-contract.js";
import type { CollectedTypeInfo, ExtraOptions } from "../type-collector.js";

import { instrumentSource } from "../instrument.js";
import { createCollectionContext, getTypeName } from "../type-collector.js";

export interface CollectOptions {
  collector?: LiteralOptions;
  /** Parse and run the input as TSX, with a React stub that builds plain objects. */
  tsx?: boolean;
}

export interface SandboxOptions extends CollectOptions {
  /** Functions the code declares, called after it has run: name to arguments. */
  calls?: Record<string, unknown[]>;
}

/**
 * Instrument → transpile → run in a sandbox → collect. There is no DOM, so an
 * arrow in a JSX attribute value is never invoked; only what the component
 * body itself calls is observed.
 */
export function collect(input: string, options: CollectOptions = {}): CollectedTypeInfo {
  const filename = options.tsx ? "test.tsx" : "test.ts";
  const instrumented = instrumentSource(input, filename, { instrumentCallExpressions: true });
  return runInSandbox(instrumented, filename, options);
}

/**
 * Run instrumented code with `__tscptr__` wired to a collection context the
 * way the loader does, and return what it recorded for `filename`.
 */
export function runInSandbox(
  instrumented: string,
  filename: string,
  options: SandboxOptions = {},
): CollectedTypeInfo {
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2015 };
  if (options.tsx) compilerOptions.jsx = ts.JsxEmit.React;
  const calls = options.calls ?? {};
  const invocations = Object.keys(calls)
    .map((name) => `;${name}(...__calls__[${JSON.stringify(name)}]);`)
    .join("");
  const compiled = ts.transpile(instrumented, compilerOptions) + invocations;

  const ctx = createCollectionContext({ literalOptions: options.collector });
  const __tscptr__ = function (
    name: string,
    value: unknown,
    pos: number,
    fname: string,
    optsJson: string,
  ) {
    ctx.record(name, value, pos, fname, JSON.parse(optsJson) as ExtraOptions);
  };
  __tscptr__.track = <T>(value: T, fname: string, offset: number): T =>
    ctx.track(value, fname, offset);
  __tscptr__.ret = <T>(value: T, pos: number, fname: string, optsJson: string): T => {
    ctx.record("(return)", value, pos, fname, JSON.parse(optsJson) as ExtraOptions);
    return value;
  };
  __tscptr__.registerFn = (fn: Function, retPos: number, fname: string): void => {
    ctx.registerFn(fn, retPos, fname);
  };
  __tscptr__.regFn = <T extends Function>(fn: T, retPos: number, fname: string): T => {
    ctx.registerFn(fn, retPos, fname);
    return fn;
  };
  __tscptr__.typeName = getTypeName;
  __tscptr__.get = () => ctx.getCollectedTypes();

  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      $$typeof: Symbol.for("test.element"),
      type,
      props: props ?? {},
      children,
    }),
    Fragment: Symbol.for("test.fragment"),
  };
  const sandbox = {
    __tscptr__,
    __calls__: calls,
    console,
    Array,
    Object,
    Promise,
    RegExp,
    Map,
    Set,
    React,
  };
  vm.runInNewContext(compiled, sandbox);
  return ctx.getCollectedTypes().filter(([f]) => f === filename);
}
