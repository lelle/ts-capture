import ts from "typescript";

import type { DiscoveredType } from "../collector-contract.js";
import type { ApplyTelemetry, ApplyTypesOptions } from "../contract.js";
import type { CollectedTypeEntry, CollectedTypeInfo, SourceLocation } from "../type-collector.js";

import { applyTypesToFileCst } from "../apply-types-cst.js";
import {
  createProjectVerificationContext,
  createVerificationContext,
  type VerificationContext,
} from "../apply-types-verify.js";
import { applyTypesToFile } from "../apply-types.js";
import { INFER_DEFAULTS, type InferOptions } from "../configuration.js";
import { describeDiagnostic } from "./matchers.js";
import { makeProject, programOf, type TestProject } from "./project.js";

// Run an applier and hold its output as a parsed, type-checked file, so a
// spec can ask what was written (the AST) and what it means (the checker)
// instead of matching the text.

export interface AppliedOptions {
  infer?: InferOptions;
  /** Run the type-check oracle, which also hands the applier a Program. */
  verify?: boolean;
  /** Hand the applier a Program without the oracle. */
  project?: boolean;
  /** Other files of the project, by name relative to its root. */
  files?: Record<string, string>;
  applier?: "cst" | "offset";
  telemetry?: ApplyTelemetry;
  /** The target's file name in the project; `target.ts` unless given. */
  filename?: string;
  /** Text put in front of every type written. */
  prefix?: string;
  /** Files the applier leaves alone, matched against the target's path. */
  ignoreFiles?: RegExp[];
}

export interface Applied {
  input: string;
  text: string;
  /** The target's absolute path in the project. */
  filename: string;
  project: TestProject;
  sf: ts.SourceFile;
  program: ts.Program;
  checker: ts.TypeChecker;
  entries: CollectedTypeInfo;
  options: AppliedOptions;
  /** Diagnostics in the output that the input did not have, by code and message. */
  newDiagnostics: ts.Diagnostic[];
  /** The oracle's context, when `verify` was asked for. */
  verify?: VerificationContext;
}

export function applied(
  source: string,
  entries: CollectedTypeInfo,
  options: AppliedOptions = {},
): Applied {
  const name = options.filename ?? "target.ts";
  const project = makeProject({ ...options.files, [name]: source });
  const filename = project.pathOf(name);
  const infer = options.infer ?? INFER_DEFAULTS;
  const { telemetry, prefix, ignoreFiles } = options;

  const before = programOf(project);
  const inputDiagnostics = diagnosticsOf(before);

  let text: string;
  let verify: VerificationContext | undefined;
  if (options.verify) {
    const projectContext = createProjectVerificationContext(
      project.fileNames,
      project.compilerOptions,
      project.dir,
    );
    verify = createVerificationContext(projectContext, filename, source);
    text = run(
      options.applier,
      source,
      entries,
      { infer, filename, verify, telemetry, prefix, ignoreFiles },
      projectContext.service.getProgram(),
    );
  } else {
    const program = options.project ? before : undefined;
    text = run(
      options.applier,
      source,
      entries,
      { infer, filename, telemetry, prefix, ignoreFiles },
      program,
    );
  }

  project.write(name, text);
  const program = programOf(project);
  const sf = program.getSourceFile(filename);
  if (!sf) throw new Error(`the output of ${name} is not in the program`);
  const checker = program.getTypeChecker();
  const newDiagnostics = subtract(diagnosticsOf(program), inputDiagnostics);
  return {
    input: source,
    text,
    filename,
    project,
    sf,
    program,
    checker,
    entries,
    options,
    newDiagnostics,
    verify,
  };
}

function run(
  applier: AppliedOptions["applier"],
  source: string,
  entries: CollectedTypeInfo,
  applyOptions: ApplyTypesOptions,
  program: ts.Program | undefined,
): string {
  const apply = applier === "offset" ? applyTypesToFile : applyTypesToFileCst;
  return apply(source, entries, applyOptions, program);
}

/** Apply the same entries to the output again; the text should not change. */
export function reapplied(out: Applied): string {
  const { options, entries, text } = out;
  const program = options.verify || options.project ? out.program : undefined;
  return run(
    options.applier,
    text,
    entries,
    { infer: options.infer ?? INFER_DEFAULTS, filename: out.filename },
    program,
  );
}

/** The names of the type aliases declared at the top level of the output, in order. */
export function aliasesDeclared(out: Applied): string[] {
  return out.sf.statements.filter(ts.isTypeAliasDeclaration).map((s) => s.name.text);
}

/** Every node of the output that satisfies `guard`, in source order. */
export function nodesOf<T extends ts.Node>(out: Applied, guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(out.sf);
  return found;
}

/** Syntax errors in the output, each as `TS<code>: <message>`. */
export function parseErrors(out: Applied): string[] {
  return out.program.getSyntacticDiagnostics(out.sf).map(describeDiagnostic);
}

/**
 * The file printed from its AST: same tokens in the same order, whatever the
 * whitespace was. Two outputs with equal printings have equal ASTs.
 */
export function printedAst(text: string): string {
  const sf = ts.createSourceFile("__printed.ts", text, ts.ScriptTarget.Latest, false);
  return ts.createPrinter({ removeComments: false }).printFile(sf);
}

function diagnosticsOf(program: ts.Program): ts.Diagnostic[] {
  const all: ts.Diagnostic[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    all.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf));
  }
  return all;
}

/**
 * The diagnostics of `after` that `before` did not have, by code and message
 * rather than by position: an insertion moves every diagnostic after it, and
 * a moved one is not new.
 */
function subtract(after: ts.Diagnostic[], before: ts.Diagnostic[]): ts.Diagnostic[] {
  const seen = new Map<string, number>();
  for (const d of before) {
    const key = describeDiagnostic(d);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return after.filter((d) => {
    const key = describeDiagnostic(d);
    const left = seen.get(key) ?? 0;
    if (left === 0) return true;
    seen.set(key, left - 1);
    return false;
  });
}

type LooseTypeTuple =
  [string | undefined] | [string | undefined, SourceLocation | undefined] | DiscoveredType;

/** One collected entry, padding loose 1/2/3-tuples to the canonical shape. */
export function entry(
  filename: string,
  offset: number,
  types: Array<LooseTypeTuple>,
  opts = {},
): CollectedTypeEntry {
  const normalized = types.map((t): DiscoveredType => [t[0], t[1] ?? undefined, t[2]]);
  return [filename, offset, normalized, opts];
}
