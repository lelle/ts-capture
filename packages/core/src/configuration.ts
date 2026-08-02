import fs from "node:fs";
import path from "node:path";

import type { CompilerOptions } from "./compiler-helper.js";
import type { ApplyTypesOptions } from "./contract.js";
import type { InstrumentOptions } from "./transformer.js";
/**
 * Inference behavior flags for type building. Every flag's default
 * matches today's behavior — adding the config layer is a no-op for
 * existing users. Future risky inference features (literal-enum
 * detection, pattern detection, etc.) ship as opt-in flags from day
 * one.
 */
export interface InferOptions {
  /** Recursively merge nested object value types across observations. */
  recursiveObjectMerge: boolean;
  /** Merge `T[] | U[]` cross-sample observations into `(T | U)[]`. */
  crossSampleArrayMerge: boolean;
  /**
   * Collapse a union of class instances to their most-specific shared
   * ancestor. Requires runtime-side `LiteralOptions.captureClassHierarchy`
   * to be on (otherwise observations don't carry the chain info needed
   * to detect shared ancestors).
   */
  rewriteCommonBase: boolean;
  /**
   * Skip varDecl / class-field annotations when TypeScript would infer
   * the same type from the initializer. Reduces noise from
   * `let count: number = 0;` (TS already infers number) and similar.
   * The inverse of removing inferable annotations from existing code
   * — this flag prevents
   * ts-capture from adding them in the first place.
   *
   * Conservative: only suppresses annotations with a strict syntactic
   * match. Numeric/string/boolean primitives only suppress for `let`
   * (since `const x = 5` infers literal type `5`, our widened `: number`
   * annotation is still meaningful). Arrays, object literals, and
   * `new Identifier(...)` suppress for both `let` and `const` since
   * those widen identically.
   */
  skipInferableVarDecls: boolean;
  /**
   * Honor user-written `as Type` and `<Type>` casts on varDecl
   * right-hand-sides. When ON (default), apply skips entries marked
   * `hasAsCast` from the transformer — the user's cast wins over the
   * runtime-observed structural type. Example motivation: in a
   * SvelteKit + Vitest + jsdom setup, `const w = window as MyWindow`
   * would otherwise be overridden by a 6KB structural type containing
   * every jsdom synthetic, producing TS2304 / TS2322 errors.
   *
   * Set to `false` to fall back to observation-wins-over-cast behavior
   * — useful when the cast is suspected wrong and ts-capture's
   * observation would correctly diverge.
   */
  honorAsCasts: boolean;
  /**
   * When emitting an annotation whose computed type is a structural
   * object literal (e.g. `{ a: number, b: string }`), compare its
   * canonical sorted-key form against `interface` and `type`
   * declarations and replace the structural form with the named one on
   * exact match. Without this, apply emits
   * `subscribe(state: { ... })` instead of
   * `subscribe(state: BookingState)` even when `BookingState` is in
   * scope, breaking symbolic binding and producing PR-diff noise.
   *
   * Uses a same-file scan, with a cross-file index when a Program is
   * available. Skips generic interfaces and interfaces that extend
   * others — canonicalisation can't safely model those without a
   * resolver.
   *
   * Default `true` — emit the named form on an exact in-scope match.
   * Set `false` to always keep the structural form (e.g. when a shape
   * happens to match an in-scope interface that wasn't the user's
   * intent — the false-positive case).
   */
  preferNamedInScope: boolean;
  /**
   * Skip the annotation when its computed type references a name that
   * isn't reachable as a type at the apply target. Avoids emitting
   * TS2304 "Cannot find name 'X'" — e.g. when ts-capture observed a
   * value whose `constructor.name === "AppLogger"` but the use-site
   * imports `Logging` from `'$lib/global/AppLogger'`, not the
   * AppLogger class itself.
   *
   * Uses a cheap text-level check by default: imports + same-file
   * declarations (interface / type / class / enum) + a baked-in
   * ECMA-core allowlist (~30 names). When a Program is available it
   * upgrades to a TypeChecker pass. False-negatives possible on DOM
   * types, namespace imports, and other lib.*.d.ts globals — those
   * annotations get skipped (position stays untyped).
   *
   * Set to `false` to fall back to "emit whatever was observed",
   * accepting that some annotations may produce TS2304.
   */
  requireTypeRefInScope: boolean;
  /**
   * Use the AST-aware applier (`applyTypesToFileCst`) instead of the
   * legacy string-offset-based `applyTypesToFile`. ON by default — the
   * CST path handles every routing case the offset-based path does,
   * plus two it doesn't (paren-less arrow return types, AST-derived
   * `this`-separator handling), and correctly skips a class-field
   * outer-annotation case the offset path emits redundantly.
   *
   * Set to false to fall back to the legacy offset-based applier
   * (e.g. for diffing two paths during migration). The
   * `applyTypesToFile` symbol is unchanged; only the CLI's dispatch
   * default changes.
   */
  cstAware: boolean;
  /**
   * TypeChecker-in-the-loop. When on, every candidate annotation is
   * probed against the project's `ts.LanguageService` via
   * `apply-types-verify.ts`. Candidates that would introduce a new
   * diagnostic in the target file or any of its transitive importers
   * are dropped.
   *
   * ON by default — the heuristic-only path regresses type errors that
   * the oracle eliminates. Opt out via `--infer.typecheckVerify=false`
   * (CLI) or `ts-capture.config.json` for the legacy fast path.
   *
   * Cost: first-run wall-clock scales with observation count.
   * Steady-state re-apply is fast via AST idempotency.
   */
  typecheckVerify: boolean;
  /**
   * Ignore existing annotations. Bypasses both
   * idempotency checks (CST `node.type !== undefined`
   * filter + offset-based `isAlreadyApplied`) so apply emits its
   * preferred annotation even at positions that already have one.
   *
   * Off by default. This mode produces SYNTACTICALLY INVALID TS
   * (existing `: T` stays in source alongside the new annotation) —
   * it's a measurement tool, not a destructive rewrite. The use case
   * is divergence-measurement workflows: "what would ts-capture emit
   * at this typed position?" Grep / diff the .applied output against
   * the original to extract the answer.
   *
   * When on, the CLI emits a stderr warning so the user can't miss
   * that the output is intentionally broken.
   */
  ignoreExistingTypes: boolean;
  /**
   * Structural-to-named recognition for common built-ins
   * (Promise/Map/Set/Date/RegExp/Error). When on, `mergeTypes`'s output
   * is checked against built-in fingerprints — a structural shape that
   * matches a built-in is rewritten to the named ref
   * (`Promise<unknown>`, `Map<unknown, unknown>`, ...).
   *
   * The rewrite only fires when the runtime emitted a structural form
   * — e.g. for a Proxy-wrapped Promise where `getTypeName` couldn't
   * read the constructor name. Real `Promise<T>` observations from
   * unwrapped values already arrive as named refs and aren't touched.
   *
   * Verify oracle gates correctness: if the named-ref form
   * fails to type-check at the target position, apply drops the
   * candidate and falls back to whatever else the pipeline produced.
   *
   * Default on. Disable via `--infer.recognizeBuiltinShapes=false`
   * for projects with custom `Promise`/`Map` classes that shadow the
   * built-ins.
   */
  recognizeBuiltinShapes: boolean;
  /**
   * When the legacy `mergeObjectTypes` bails on a multi-observation
   * entry (no-overlap fallback OR literal-discriminator bail), fall
   * back to the anti-unification machinery in `type-ir.ts`.
   *
   * Cases:
   *   - lub structurally merges the observations → use that
   *     (object node with combined required + optional keys).
   *   - lub also bails to a flat union over DISJOINT shapes (no shared
   *     keys across the members) → strong polymorphic-position signal.
   *     We emit `unknown` instead of the wide flat union, treating the
   *     position as genuinely generic until a proper generic-parameter
   *     inference step can do better. With
   *     `emitDiagnosticComments` on, a `@ts-capture:polymorphic-position`
   *     marker tags the position for review tooling.
   *   - lub returns a non-disjoint union (some shared keys, but not
   *     structurally mergeable) → keep the legacy flat union; no change.
   *
   * Verify oracle still gates: a structurally-merged lub result
   * that introduces type errors gets rejected at apply time like any
   * other candidate.
   *
   * Default off (opt-in for v1).
   */
  lubFallback: boolean;
  literal: {
    /** Preserve string literal types (e.g. `"yes" | "no"`) up to maxLength. */
    string: boolean;
    /** Max length of string literals to preserve. Ignored if `string=false`. */
    stringMaxLength: number;
    /** Preserve number literal types observed across samples. */
    number: boolean;
    /** Preserve boolean literal types (true/false individually). */
    boolean: boolean;
  };
  patternDetection: {
    /** Detect ISO date strings and emit `Date`. */
    isoDate: boolean;
    /** Detect UUID-shaped strings. */
    uuid: boolean;
    /** Detect URL-shaped strings. */
    url: boolean;
  };
  narrowOptional: {
    /** Prefer `T | undefined` over `T | null` when both observed. */
    preferUndefinedOverNull: boolean;
  };
  /**
   * Emit `/* @ts-capture:<reason> *​/` marker comments next to
   * annotations where ts-capture fell back to a coarse / generic emit
   * because the precise shape couldn't be observed. Reviewers can use
   * the markers to distinguish confident emits from fallbacks. Default
   * `false` to keep apply output noise-free; opt in per-project when
   * the team wants the diagnostic signal in the diff.
   *
   * Marker vocabulary (additive only; never removed in semver-compatible
   * releases):
   *   - `@ts-capture:generic-fn` — function value observed, no signature
   *   - `@ts-capture:shape-capped` — object/array exceeded maxAnnotationChars
   */
  emitDiagnosticComments: boolean;
  /**
   * Maximum character length of a final annotation type string. When the
   * post-merge union exceeds this cap, the annotation is suppressed
   * entirely rather than emitted in bloated form — TS's own inference
   * (and any existing typing in scope) takes over for that position.
   *
   * Typical origin of capped annotations: logger / serializer functions
   * that get passed the entire app state. A 19K-character annotation
   * locks the full state shape into source and is less readable than
   * `any`.
   *
   * Default 4096 matches the collection-time `maxAnnotationChars`
   * fallback used by `getTypeName`.
   */
  maxAnnotationChars: number;
}

export const INFER_DEFAULTS: InferOptions = {
  recursiveObjectMerge: true,
  crossSampleArrayMerge: false,
  rewriteCommonBase: false,
  skipInferableVarDecls: false,
  honorAsCasts: true,
  preferNamedInScope: true,
  requireTypeRefInScope: true,
  cstAware: true,
  typecheckVerify: true,
  ignoreExistingTypes: false,
  recognizeBuiltinShapes: true,
  lubFallback: false,
  literal: {
    string: false,
    stringMaxLength: 16,
    number: false,
    boolean: false,
  },
  patternDetection: {
    isoDate: false,
    uuid: false,
    url: false,
  },
  narrowOptional: {
    preferUndefinedOverNull: true,
  },
  emitDiagnosticComments: false,
  maxAnnotationChars: 4096,
};

/**
 * Recursive partial — ts-capture.config.json may specify nested keys without
 * supplying every field of the nested object.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** CLI-level `ts-capture apply` behavior (distinct from the per-file applier `ApplyTypesOptions`). */
export interface ApplyCliOptions {
  /**
   * Gitignore-style globs for files `apply` should skip. The built-in
   * test-file default is the implicit first entry; these stack on top
   * (additive, last-match-wins, leading `!` re-includes). See
   * `buildSkipMatcher` in apply-skip.ts for the supported glob subset.
   */
  skipFiles?: string[];
}

export interface TsCaptureConfig {
  common?: Partial<CompilerOptions>;
  instrument?: Partial<InstrumentOptions>;
  applyTypes?: Partial<ApplyTypesOptions>;
  apply?: ApplyCliOptions;
  infer?: DeepPartial<InferOptions>;
}

export function findConfigFile(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, "ts-capture.config.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfig(configPath: string): TsCaptureConfig {
  const resolved = path.resolve(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf-8");
  } catch {
    throw new Error(`Cannot read config file: ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${resolved}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Config file must be a JSON object: ${resolved}`);
  }

  return parsed as TsCaptureConfig;
}

export function resolveInstrumentOptions(
  config: TsCaptureConfig,
  configDir?: string,
): InstrumentOptions {
  const common = resolveCompilerOptions(config, configDir);
  return { ...common, ...config.instrument };
}

export function resolveApplyTypesOptions(
  config: TsCaptureConfig,
  configDir?: string,
): ApplyTypesOptions {
  const common = resolveCompilerOptions(config, configDir);
  return { ...common, ...config.applyTypes };
}

function resolveCompilerOptions(config: TsCaptureConfig, configDir?: string): CompilerOptions {
  const opts: CompilerOptions = { ...config.common };
  if (configDir) {
    if (opts.rootDir) opts.rootDir = path.resolve(configDir, opts.rootDir);
    if (opts.tsConfig) opts.tsConfig = path.resolve(configDir, opts.tsConfig);
  }
  return opts;
}

/**
 * Resolve InferOptions from a config: deep-merge the user's partial
 * over INFER_DEFAULTS so every flag has a concrete value at apply time.
 */
export function resolveInferOptions(config: TsCaptureConfig): InferOptions {
  return deepMergeInfer(INFER_DEFAULTS, config.infer);
}

function deepMergeInfer(
  defaults: InferOptions,
  overrides: DeepPartial<InferOptions> | undefined,
): InferOptions {
  if (!overrides) return defaults;
  return {
    recursiveObjectMerge: overrides.recursiveObjectMerge ?? defaults.recursiveObjectMerge,
    crossSampleArrayMerge: overrides.crossSampleArrayMerge ?? defaults.crossSampleArrayMerge,
    rewriteCommonBase: overrides.rewriteCommonBase ?? defaults.rewriteCommonBase,
    skipInferableVarDecls: overrides.skipInferableVarDecls ?? defaults.skipInferableVarDecls,
    honorAsCasts: overrides.honorAsCasts ?? defaults.honorAsCasts,
    preferNamedInScope: overrides.preferNamedInScope ?? defaults.preferNamedInScope,
    requireTypeRefInScope: overrides.requireTypeRefInScope ?? defaults.requireTypeRefInScope,
    cstAware: overrides.cstAware ?? defaults.cstAware,
    typecheckVerify: overrides.typecheckVerify ?? defaults.typecheckVerify,
    ignoreExistingTypes: overrides.ignoreExistingTypes ?? defaults.ignoreExistingTypes,
    recognizeBuiltinShapes: overrides.recognizeBuiltinShapes ?? defaults.recognizeBuiltinShapes,
    lubFallback: overrides.lubFallback ?? defaults.lubFallback,
    literal: {
      string: overrides.literal?.string ?? defaults.literal.string,
      stringMaxLength: overrides.literal?.stringMaxLength ?? defaults.literal.stringMaxLength,
      number: overrides.literal?.number ?? defaults.literal.number,
      boolean: overrides.literal?.boolean ?? defaults.literal.boolean,
    },
    patternDetection: {
      isoDate: overrides.patternDetection?.isoDate ?? defaults.patternDetection.isoDate,
      uuid: overrides.patternDetection?.uuid ?? defaults.patternDetection.uuid,
      url: overrides.patternDetection?.url ?? defaults.patternDetection.url,
    },
    narrowOptional: {
      preferUndefinedOverNull:
        overrides.narrowOptional?.preferUndefinedOverNull ??
        defaults.narrowOptional.preferUndefinedOverNull,
    },
    emitDiagnosticComments: overrides.emitDiagnosticComments ?? defaults.emitDiagnosticComments,
    maxAnnotationChars: overrides.maxAnnotationChars ?? defaults.maxAnnotationChars,
  };
}

/**
 * Parse `--infer.<dot.path>=<value>` CLI flags into a DeepPartial<InferOptions>.
 * Values are coerced: "true"/"false" → boolean, numeric strings → number,
 * everything else → string.
 *
 * Example: ["--infer.literal.string=true", "--infer.literal.stringMaxLength=24"]
 *   → { literal: { string: true, stringMaxLength: 24 } }
 */
export function parseInferFlagOverrides(args: string[]): DeepPartial<InferOptions> {
  const result: Record<string, unknown> = {};
  for (const arg of args) {
    if (!arg.startsWith("--infer.")) continue;
    const eqIdx = arg.indexOf("=");
    if (eqIdx < 0) continue;
    const dotPath = arg.slice("--infer.".length, eqIdx).split(".");
    const rawValue = arg.slice(eqIdx + 1);
    let coerced: unknown;
    if (rawValue === "true") coerced = true;
    else if (rawValue === "false") coerced = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) coerced = Number(rawValue);
    else coerced = rawValue;

    let target: Record<string, unknown> = result;
    for (let i = 0; i < dotPath.length - 1; i++) {
      const key = dotPath[i];
      if (typeof target[key] !== "object" || target[key] === null) {
        target[key] = {};
      }
      target = target[key] as Record<string, unknown>;
    }
    target[dotPath[dotPath.length - 1]] = coerced;
  }
  return result as DeepPartial<InferOptions>;
}
