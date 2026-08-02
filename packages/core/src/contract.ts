import type { ProjectVerificationContext, VerificationContext } from "./apply-types-verify.js";
import type { CompilerOptions } from "./compiler-helper.js";
import type { InferOptions } from "./configuration.js";

/**
 * Per-reason skip counters surfaced via `--telemetry`. Mutable sink:
 * the caller (`cmdApply`) allocates one, threads it through every
 * `applyTypesToFile` / `applyTypesToFileCst` call, prints the summary
 * at end of run.
 *
 * Categories:
 *   - `idempotent`: position already typed in source (CST `node.type`
 *     check + offset `isAlreadyApplied`).
 *   - `unparseable`: candidate type string failed the parse / format
 *     pre-check; can't safely emit.
 *   - `positionMismatch`: offset doesn't match a valid insertion site
 *     (`validVarDeclEnds`, `validArrowParamEnds`, etc.).
 *   - `verifyReject`: verify oracle said this annotation would
 *     introduce a type error.
 *   - `other`: derived (`total - emitted - sum(above)`). Includes the
 *     per-rule heuristics whose breakdown is
 *     a follow-up.
 */
export interface ApplyTelemetry {
  totalEntries: number;
  emitted: number;
  idempotent: number;
  unparseable: number;
  positionMismatch: number;
  verifyReject: number;
}

/**
 * Allocate a fresh zeroed `ApplyTelemetry`. CLI / library callers use
 * this to start a run.
 */
export function newApplyTelemetry(): ApplyTelemetry {
  return {
    totalEntries: 0,
    emitted: 0,
    idempotent: 0,
    unparseable: 0,
    positionMismatch: 0,
    verifyReject: 0,
  };
}

export interface ApplyTypesOptions extends CompilerOptions {
  prefix?: string;
  /** Inference behavior flags. Defaults match INFER_DEFAULTS (today's behavior). */
  infer?: InferOptions;
  /**
   * Optional sink for per-reason apply telemetry. When provided,
   * counters at each skip / emit point are incremented. Mutates the
   * object in place; callers aggregate per file or per run as needed.
   */
  telemetry?: ApplyTelemetry;
  /**
   * Target file's path, used to look up the SourceFile in the Program when
   * the TypeChecker-aware scope check is active. Provided by the CLI
   * (`cmdApply`) per file. When omitted or when no Program is passed, the
   * applier falls back to the text-level scope check (imports + same-file
   * decls + ECMA core).
   */
  filename?: string;
  /**
   * RegExp patterns matched against `filename`. When any matches, apply
   * returns source unchanged for this file. Use for files where apply
   * is known to produce noise (loggers, generated code) or for staged
   * rollouts where some directories aren't ready yet. No effect when
   * `filename` is not provided.
   */
  ignoreFiles?: RegExp[];
  /**
   * TypeChecker-in-the-loop context. When present (i.e. when
   * `infer.typecheckVerify` is on and the CLI built a LanguageService
   * for the file), each candidate replacement is probed against the
   * project type-checker before being committed. Candidates that would
   * introduce a new diagnostic in the target file are dropped.
   *
   * `undefined` for the legacy heuristic-only behavior (default today).
   */
  verify?: VerificationContext;
  /**
   * Project-scoped verification context, passed to applier
   * plugins (e.g. `@ts-capture/svelte`) so they can register a virtual
   * TS file per framework block and build a per-block `verify` context
   * over it. `.svelte` files aren't in the tsconfig program, so the CLI
   * can't supply a per-file `verify` for them; handing over the project
   * context lets the plugin opt its blocks into typecheck-verify.
   *
   * Unused by the built-in `.ts` applier (which gets `verify` + a
   * `program` directly). `undefined` when typecheckVerify is off.
   */
  projectVerify?: ProjectVerificationContext;
}
