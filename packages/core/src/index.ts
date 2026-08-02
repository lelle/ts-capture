// --- Core pipeline ---

/** Instrument TypeScript source so its call sites record runtime argument and return values at test time. */
export { instrumentSource } from "./instrument.js";

/** Apply collected types to a single file, or to many files, via the offset-based applier. */
export { applyTypesToFile, applyTypesToFiles } from "./apply-types.js";

/** Apply collected types via the AST-aware (CST) applier — the default, offset-drift-resistant path. */
export { applyTypesToFileCst } from "./apply-types-cst.js";

/** Compute annotation coverage (how many inferable positions carry a type) for a source file. */
export { typeCoverage } from "./type-coverage.js";

/** Verify that applied annotations introduce no new type errors; check a single annotation's compatibility. */
export { verifyTypes, isCompatible } from "./verify.js";

// --- Applier plugins ---

/** The applier-plugin contract and the per-file routing decision it produces. */
export type { ApplierPlugin, PluginRouting } from "./applier-plugin.js";

/** Route a file to its matching applier plugin; load the plugin set declared in config. */
export { routeFile, loadPluginsFromConfig } from "./applier-plugin.js";

// --- Verification ---

/** Build the verify contexts (project-wide or per-file) and register an in-memory virtual file with one. */
export {
  createProjectVerificationContext,
  createVerificationContext,
  registerVirtualFile,
} from "./apply-types-verify.js";

/** The two verify-context shapes: a shared project context and a per-file context. */
export type { ProjectVerificationContext, VerificationContext } from "./apply-types-verify.js";

// --- Bundle / source-map round-trip ---

/** Instrument an already-bundled file, recording positions for later source-map translation. */
export { instrumentBundle } from "./bundle/instrument-bundle.js";

/** Translate observations gathered from a bundle back to original source positions via its source map. */
export { translateBundleObservations } from "./bundle/translate-observations.js";

/** Inputs and result of bundle instrumentation. */
export type {
  BundleObservation,
  InstrumentBundleOptions,
  InstrumentBundleResult,
} from "./bundle/instrument-bundle.js";

/** Inputs and result of bundle-observation source-map translation. */
export type {
  TranslateBundleOptions,
  TranslateBundleResult,
} from "./bundle/translate-observations.js";

// --- Type collector (runtime) ---

/** Reflect a runtime value into a TypeScript type string; read the last walk's depth-exceeded flag; build a collection context. */
export { getTypeName, wasDepthExceeded, createCollectionContext } from "./type-collector.js";

// --- AST transformation (advanced) ---

/** The ts-capture transformer factory and the single-source-file transform entry point. */
export { tsCaptureTransformer, transformSourceFile } from "./transformer.js";

// --- Building blocks ---

/** A text-replacement primitive (insert/replace at offsets) and the function that applies a batch of them. */
export { Replacement, applyReplacements } from "./replacement.js";

/** Build a `ts.Program` (with TypeChecker) for the given files and compiler options. */
export { getProgram } from "./compiler-helper.js";

/** Config discovery, loading, and resolution of instrument / apply / infer options, plus inference defaults. */
export {
  findConfigFile,
  loadConfig,
  resolveInstrumentOptions,
  resolveApplyTypesOptions,
  resolveInferOptions,
  parseInferFlagOverrides,
  INFER_DEFAULTS,
} from "./configuration.js";

// --- Types ---

/** Options controlling source instrumentation. */
export type { InstrumentOptions } from "./transformer.js";

/** Options controlling how collected types are applied to source. */
export type { ApplyTypesOptions } from "./contract.js";

/** Compiler options accepted when building a `ts.Program`. */
export type { CompilerOptions } from "./compiler-helper.js";

/** The result of a `typeCoverage` run. */
export type { TypeCoverageResult } from "./type-coverage.js";

/** User-facing config shape, inference flags, and a deep-partial helper for overrides. */
export type { TsCaptureConfig, InferOptions, DeepPartial } from "./configuration.js";

/** The runtime collector's observation wire-format and context types. */
export type {
  SourceLocation,
  ExtraOptions,
  CollectedTypeEntry,
  CollectedTypeInfo,
  CollectionContext,
  CollectorOptions,
  Diagnostic,
  LiteralOptions,
} from "./type-collector.js";

/** The verify oracle's per-entry verdict, entry, and aggregate report. */
export type { VerifyVerdict, VerifyEntry, VerifyReport } from "./verify.js";
