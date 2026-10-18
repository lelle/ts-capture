import type ts from "typescript";

import type { CollectedTypeInfo } from "./collector-contract.js";

import { applyTypesToFileCst } from "./apply-types-cst.js";
import {
  advanceCurrentSource,
  createVerificationContext,
  orderByImports,
  type ProjectVerificationContext,
  type VerificationContext,
} from "./apply-types-verify.js";
import { INFER_DEFAULTS, type InferOptions } from "./configuration.js";
import { type ApplySkip, type ApplyTelemetry, newApplyTelemetry } from "./contract.js";

/** How much the applier can ask TypeScript. Each tier can do what the one before it can. */
export type TypeOracle =
  /** Syntax only. */
  | { kind: "none" }
  /** The checker of a Program holding the file: redundancy and scope by type. */
  | { kind: "program"; program: ts.Program }
  /** A project to type-check each candidate against before it is written. */
  | { kind: "project"; project: ProjectVerificationContext };

export interface AnnotateOptions {
  /** The path the oracle knows the text by. */
  filename?: string;
  /** Merged over the defaults. */
  infer?: Partial<InferOptions>;
  oracle?: TypeOracle;
  /** Matched against `filename`; a match leaves the text as it is. */
  ignoreFiles?: RegExp[];
}

export interface AnnotateResult {
  text: string;
  /** Entries that were not written, with why; positions are offsets into the text given. */
  skips: readonly ApplySkip[];
  telemetry: ApplyTelemetry;
}

export interface AnnotateProjectInput {
  /** Entries for any number of files, keyed by the path in each entry. */
  types: CollectedTypeInfo;
  readFile: (path: string) => string | undefined;
  /** With `project`, files are annotated in import order, imports first. */
  oracle?: TypeOracle;
  infer?: Partial<InferOptions>;
  ignoreFiles?: RegExp[];
}

export interface AnnotateProjectResult {
  /** One result per observed file that could be read. */
  files: Map<string, AnnotateResult>;
  telemetry: ApplyTelemetry;
}

/** Write the observed types into one file's text. Positions in `entries` are offsets into `text`. */
export function annotate(
  text: string,
  entries: CollectedTypeInfo,
  options: AnnotateOptions = {},
): AnnotateResult {
  const oracle = options.oracle ?? { kind: "none" };
  const verify =
    oracle.kind === "project" && options.filename
      ? createVerificationContext(oracle.project, options.filename, text)
      : undefined;
  return annotateWith(text, entries, options, verify);
}

/** Write the observed types into every file they name. */
export function annotateProject(input: AnnotateProjectInput): AnnotateProjectResult {
  const oracle = input.oracle ?? { kind: "none" };
  const grouped = new Map<string, CollectedTypeInfo>();
  for (const e of input.types) {
    const entries = grouped.get(e[0]);
    if (entries) entries.push(e);
    else grouped.set(e[0], [e]);
  }
  // A file whose annotations another file's inference depends on goes first.
  const files =
    oracle.kind === "project"
      ? orderByImports(
          [...grouped.keys()],
          oracle.project.reverseImportGraph,
          oracle.project.system.useCaseSensitiveFileNames,
        )
      : [...grouped.keys()];

  const results = new Map<string, AnnotateResult>();
  const telemetry = newApplyTelemetry();
  for (const file of files) {
    const text = input.readFile(file);
    if (text === undefined) continue;
    const options = { filename: file, infer: input.infer, oracle, ignoreFiles: input.ignoreFiles };
    const verify =
      oracle.kind === "project" ? createVerificationContext(oracle.project, file, text) : undefined;
    const result = annotateWith(text, grouped.get(file)!, options, verify);
    // The next file is checked against this one as written.
    if (verify) advanceCurrentSource(verify, result.text);
    for (const skip of result.skips) skip.file = file;
    addTelemetry(telemetry, result.telemetry);
    results.set(file, result);
  }
  return { files: results, telemetry };
}

function annotateWith(
  text: string,
  entries: CollectedTypeInfo,
  options: AnnotateOptions,
  verify: VerificationContext | undefined,
): AnnotateResult {
  const oracle = options.oracle ?? { kind: "none" };
  const telemetry = newApplyTelemetry();
  const program =
    oracle.kind === "program"
      ? oracle.program
      : oracle.kind === "project"
        ? oracle.project.service.getProgram()
        : undefined;
  const out = applyTypesToFileCst(
    text,
    entries,
    {
      infer: { ...INFER_DEFAULTS, ...options.infer },
      filename: options.filename,
      ignoreFiles: options.ignoreFiles,
      verify,
      telemetry,
    },
    program,
  );
  return { text: out, skips: telemetry.skipped, telemetry };
}

function addTelemetry(into: ApplyTelemetry, from: ApplyTelemetry): void {
  into.totalEntries += from.totalEntries;
  into.emitted += from.emitted;
  into.idempotent += from.idempotent;
  into.unparseable += from.unparseable;
  into.positionMismatch += from.positionMismatch;
  into.verifyReject += from.verifyReject;
  into.redundant += from.redundant;
  into.skipped.push(...from.skipped);
}
