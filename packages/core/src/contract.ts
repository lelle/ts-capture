import type { ProjectVerificationContext, VerificationContext } from "./apply-types-verify.js";
import type { CompilerOptions } from "./compiler-helper.js";
import type { InferOptions } from "./configuration.js";

/**
 * Per-reason skip counters surfaced via `--telemetry`. Mutable sink:
 * the caller (`cmdApply`) allocates one, threads it through every
 * file it applies, prints the summary at end of run.
 *
 * Categories:
 *   - `idempotent`: position already typed in source (`node.type`).
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
/** Why an observed position got no annotation. */
export type ApplySkipReason =
  /** The type-check oracle rejected it; `diagnostic` says with what. */
  | "type-error"
  /** The observation describes no usable type (`unknown`, an empty array, …). */
  | "no-information"
  /** It names a type the target file cannot reach. */
  | "out-of-scope"
  /** The observed value falls outside the type already there. */
  | "contradiction"
  /** TypeScript already infers the same type. */
  | "redundant"
  /** The code already says something an observation must not overwrite. */
  | "kept-existing"
  /** A type is already written there. */
  | "already-annotated"
  /** The declaration is marked `@ts-capture-ignore`. */
  | "ignored"
  /** TypeScript infers a wider type than the observations show, and keeps it. */
  | "left-to-typescript"
  /** The position is no place a type can be written, as when the code changed since the run. */
  | "no-site";

/**
 * Every rule apply decides a site by. A reason says what happened; a rule says
 * which check made it so, since one reason has several.
 */
export const APPLY_RULES = [
  // From the code's syntax, before any type is asked for.
  "syntax.ignored",
  "syntax.already-typed",
  "syntax.no-site",
  "syntax.outer-conflict",
  "syntax.one-branch-seen",
  "syntax.only-undefined-seen",
  "syntax.as-cast",
  "syntax.as-const",
  "syntax.unique-symbol",
  "syntax.array-callback-shape",
  "syntax.redundant-initializer",
  // From what was observed.
  "info.never-passed",
  "info.nothing-left",
  "info.too-long",
  "info.out-of-scope",
  "info.unparseable",
  "info.describes-nothing",
  // From what TypeScript infers at the site (`checker-gate.ts`).
  "gate.polymorphic-this",
  "gate.call-signature",
  "gate.erases-named-type",
  "gate.erases-enum",
  "gate.discards-union-arm",
  "gate.contradiction",
  "gate.redundant",
  // From type-checking the file with the annotations written.
  "verify.type-error",
  "verify.wider-after-run",
  "written",
] as const;

export type ApplyRule = (typeof APPLY_RULES)[number];

/** A rule that writes nothing. */
export type SkipRule = Exclude<ApplyRule, "written">;

/** What a rule that writes nothing reports as its reason: always the same one. */
export const REASON_OF: Record<SkipRule, ApplySkipReason> = {
  "syntax.ignored": "ignored",
  "syntax.already-typed": "already-annotated",
  "syntax.no-site": "no-site",
  "syntax.outer-conflict": "kept-existing",
  "syntax.one-branch-seen": "left-to-typescript",
  "syntax.only-undefined-seen": "left-to-typescript",
  "syntax.as-cast": "kept-existing",
  "syntax.as-const": "kept-existing",
  "syntax.unique-symbol": "kept-existing",
  "syntax.array-callback-shape": "redundant",
  "syntax.redundant-initializer": "redundant",
  "info.never-passed": "no-information",
  "info.nothing-left": "no-information",
  "info.too-long": "no-information",
  "info.out-of-scope": "out-of-scope",
  "info.unparseable": "no-information",
  "info.describes-nothing": "no-information",
  "gate.polymorphic-this": "kept-existing",
  "gate.call-signature": "kept-existing",
  "gate.erases-named-type": "kept-existing",
  "gate.erases-enum": "kept-existing",
  "gate.discards-union-arm": "left-to-typescript",
  "gate.contradiction": "contradiction",
  "gate.redundant": "redundant",
  "verify.type-error": "type-error",
  "verify.wider-after-run": "left-to-typescript",
};

export interface ApplySkip {
  /** Offset in the source handed to the applier. */
  pos: number;
  reason: ApplySkipReason;
  /** Set by core's applier; a plugin's own skips may leave it out. */
  rule?: ApplyRule;
  /** The observed type-strings, joined as a union. */
  observed: string;
  detail?: string;
  diagnostic?: { code: number; message: string; file: string; line: number };
  /** Filled in by the caller that knows which file was being applied. */
  file?: string;
}

export interface ApplyTelemetry {
  totalEntries: number;
  emitted: number;
  idempotent: number;
  unparseable: number;
  positionMismatch: number;
  verifyReject: number;
  /** The part of `idempotent` that was a restatement rather than an existing annotation. */
  redundant: number;
  /** One record per observed position that was not written. */
  skipped: ApplySkip[];
  /** One record per position written. A plugin's telemetry may leave it out. */
  written?: ApplyWrite[];
}

export interface ApplyWrite {
  /** Offset in the source handed to the applier. */
  pos: number;
  rule: ApplyRule;
  /** The type written. */
  type: string;
  /** Filled in by the caller that knows which file was being applied. */
  file?: string;
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
    redundant: 0,
    skipped: [],
    written: [],
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
