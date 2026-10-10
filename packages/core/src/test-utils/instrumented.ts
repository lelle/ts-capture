import ts from "typescript";

import type { InstrumentOptions } from "../transformer.js";
import type { CollectedTypeInfo, ExtraOptions } from "../type-collector.js";

import { instrumentSource } from "../instrument.js";
import { runInSandbox, type SandboxOptions } from "./collected.js";
import { type CallForm, callFormOf, stripInstrumentation } from "./strip-instrumentation.js";

// Run the instrumenter and hold its output as a parsed file and a list of
// decoded `__tscptr__` calls, so a spec can ask what was instrumented (the
// calls) and what running it observes (the sandbox) instead of matching how
// a call is spelled.

export interface TrackedCall {
  form: CallForm;
  /** The first argument of a parameter call; the other forms carry no name. */
  name?: string;
  /** The offset in the input the call records at. */
  pos: number;
  filename: string;
  /** The decoded options; `{}` for the forms that carry none. */
  options: ExtraOptions;
  /** The expression handed to the call, as written in the output. */
  valueText: string;
  node: ts.CallExpression;
}

/** What an output may do that an instrumented output otherwise may not. */
export interface Allow {
  /** A call whose offset is not a site of the input. */
  positions?: boolean;
  /** An output that is more than its input plus the calls. */
  changes?: boolean;
}

export interface InstrumentedOptions {
  /** The name the instrumenter is given; `test.ts` unless given. */
  filename?: string;
  options?: InstrumentOptions;
  allow?: Allow;
}

export interface InspectedOptions {
  /** The source the output was produced from; without it only parsing is checked. */
  input?: string;
  filename?: string;
  /** Hold the output to being its input plus the calls, as `instrumented()` does. */
  additive?: boolean;
  allow?: Allow;
}

export interface Instrumented {
  input?: string;
  text: string;
  filename: string;
  sf: ts.SourceFile;
  calls: TrackedCall[];
  /** Run the output in the sandbox and return what was recorded for the file. */
  run(calls?: SandboxOptions["calls"]): Observed;
}

export interface Observed {
  input?: string;
  filename: string;
  entries: CollectedTypeInfo;
}

/** An output whose input is known, as every output of `instrumented()` is. */
export type InstrumentedSource = Instrumented & { input: string };

export function instrumented(
  source: string,
  options: InstrumentedOptions = {},
): InstrumentedSource {
  const filename = options.filename ?? "test.ts";
  const text = instrumentSource(source, filename, options.options);
  const out = inspected(text, { input: source, filename, additive: true, allow: options.allow });
  return { ...out, input: source };
}

/** An output produced elsewhere, such as by a plugin or a bundler, held the same way. */
export function inspected(text: string, options: InspectedOptions = {}): Instrumented {
  const { input, allow } = options;
  const filename = options.filename ?? "test.ts";
  const sf = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  assertParses(text, filename);
  const calls = callsOf(sf);
  if (input !== undefined && !allow?.positions) assertPositions(input, filename, calls, sf);
  if (input !== undefined && options.additive && !allow?.changes) {
    assertAdditive(input, text, filename);
  }
  return {
    input,
    text,
    filename,
    sf,
    calls,
    run: (invocations) => ({
      input,
      filename,
      entries: runInSandbox(text, filename, { calls: invocations, tsx: isTsx(filename) }),
    }),
  };
}

/** The offset just past the first occurrence of `needle` in `source`. */
export function endOf(source: string, needle: string): number {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`no ${needle} in:\n${source}`);
  return start + needle.length;
}

/** The start and end of the first occurrence of `needle` in `source`. */
export function spanOf(source: string, needle: string): [number, number] {
  const end = endOf(source, needle);
  return [end - needle.length, end];
}

const isTsx = (filename: string): boolean => /\.[jt]sx$/.test(filename);
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A call as the output spells it, on one line. */
export function callText(call: TrackedCall): string {
  return collapse(call.node.getText());
}

/** Every `__tscptr__` call in the file, decoded, in source order. */
function callsOf(sf: ts.SourceFile): TrackedCall[] {
  const calls: TrackedCall[] = [];
  const visit = (node: ts.Node): void => {
    const form = callFormOf(node);
    if (form) calls.push(decode(node as ts.CallExpression, form));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

// Where each form carries its value, offset, file and options.
const LAYOUT: Record<CallForm, { value: number; pos: number; filename: number; options?: number }> =
  {
    param: { value: 1, pos: 2, filename: 3, options: 4 },
    ret: { value: 0, pos: 1, filename: 2, options: 3 },
    track: { value: 0, pos: 2, filename: 1 },
    regFn: { value: 0, pos: 1, filename: 2 },
    registerFn: { value: 0, pos: 1, filename: 2 },
  };

function decode(node: ts.CallExpression, form: CallForm): TrackedCall {
  const layout = LAYOUT[form];
  const argument = (index: number): ts.Expression => {
    const found = node.arguments[index];
    if (!found) throw undecodable(node, `it has no argument ${index + 1}`);
    return found;
  };
  const text = (index: number): string => {
    const literal = argument(index);
    if (!ts.isStringLiteralLike(literal)) {
      throw undecodable(node, `${literal.getText()} is not a string literal`);
    }
    return literal.text;
  };
  const number = (index: number): number => {
    const literal = argument(index);
    if (!ts.isNumericLiteral(literal)) {
      throw undecodable(node, `${literal.getText()} is not a numeric literal`);
    }
    return Number(literal.text);
  };
  return {
    form,
    name: form === "param" ? text(0) : undefined,
    pos: number(layout.pos),
    filename: text(layout.filename),
    options: layout.options === undefined ? {} : (JSON.parse(text(layout.options)) as ExtraOptions),
    valueText: collapse(argument(layout.value).getText()),
    node,
  };
}

function undecodable(node: ts.CallExpression, why: string): Error {
  return new Error(`cannot decode ${collapse(node.getText())}: ${why}`);
}

function assertParses(text: string, filename: string): void {
  const { diagnostics = [] } = ts.transpileModule(text, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve },
  });
  if (diagnostics.length === 0) return;
  const errors = diagnostics.map(
    (d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
  );
  throw new Error(`the output does not parse:\n  ${errors.join("\n  ")}\n${text}`);
}

/** The offsets of the input a call may record at, each by what stands there. */
interface Sites {
  /** The end of a declared name (past a `?`): the name, or null for a pattern. */
  names: Map<number, string | null>;
  /** The start of a parameter list, where an implicit `this` would go. */
  parameterLists: Set<number>;
  /** Past the `)` of a parameter list, or the end of a bare arrow parameter. */
  returns: Set<number>;
  /** The start of any node, where a tracked argument begins. */
  starts: Set<number>;
}

function sitesOf(input: string, filename: string): Sites {
  const sf = ts.createSourceFile(filename, input, ts.ScriptTarget.Latest, true);
  const sites: Sites = {
    names: new Map(),
    parameterLists: new Set(),
    returns: new Set(),
    starts: new Set(),
  };
  const visit = (node: ts.Node): void => {
    sites.starts.add(node.getStart(sf));
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      const optional = ts.isParameter(node) && node.questionToken ? 1 : 0;
      sites.names.set(
        node.name.getEnd() + optional,
        ts.isIdentifier(node.name) ? node.name.text : null,
      );
    }
    if (ts.isFunctionLike(node)) {
      sites.parameterLists.add(node.parameters.pos);
      sites.returns.add(node.parameters.end);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function assertPositions(
  input: string,
  filename: string,
  calls: TrackedCall[],
  sf: ts.SourceFile,
): void {
  const sites = sitesOf(input, filename);
  const isReturn = (pos: number): boolean => sites.returns.has(pos) || input[pos - 1] === ")";
  for (const call of calls) {
    const problem = positionProblem(call, sites, isReturn);
    if (problem) {
      throw new Error(
        `${callText(call)} records at offset ${call.pos}, but ${problem}:\n${input}\n` +
          `in the output:\n${sf.text}`,
      );
    }
  }
}

function positionProblem(
  call: TrackedCall,
  sites: Sites,
  isReturn: (pos: number) => boolean,
): string | undefined {
  const { form, pos, options } = call;
  const declared = sites.names.get(pos);
  if (form === "track") {
    return sites.starts.has(pos) ? undefined : "no expression of the input starts there";
  }
  if (form === "regFn" || form === "registerFn" || options.returnType) {
    return isReturn(pos) ? undefined : "no parameter list of the input ends there";
  }
  if (form === "param" && call.name === "this") {
    return sites.parameterLists.has(pos)
      ? undefined
      : "no parameter list of the input starts there";
  }
  if (declared === undefined) return "no parameter or declared name of the input ends there";
  const expected = form === "param" ? call.name : options.paramReturnMember;
  if (expected !== undefined && declared !== null && declared !== expected) {
    return `the name that ends there is ${declared}`;
  }
  return undefined;
}

function assertAdditive(input: string, text: string, filename: string): void {
  const stripped = stripInstrumentation(text, filename);
  const expected = stripInstrumentation(input, filename);
  if (stripped === expected) return;
  throw new Error(
    "the instrumenter changed more than it added. Without the __tscptr__ calls the output is:\n" +
      `${stripped}\nbut the input is:\n${expected}`,
  );
}
