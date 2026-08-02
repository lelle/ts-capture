// Stable type contract for the value-reflection subtree. These are the
// public types consumed across @ts-capture/core, @ts-capture/vite, and
// @ts-capture/svelte. Routing them through this leaf (mirroring the
// `contract.ts` precedent from the apply-types decomposition) lets the walker,
// signature-algebra, and collection-context modules be split apart without any
// importer seeing a moved path.
//
// Pure types only — no `typescript` import, no runtime values. A `ts.`
// reference appearing here means a concern has leaked and belongs elsewhere.

export type SourceLocation = [string, number]; // [filename, offset]

export interface ExtraOptions {
  arrow?: boolean;
  parens?: [number, number];
  thisType?: boolean;
  thisNeedsComma?: boolean;
  returnType?: boolean;
  async?: boolean;
  fnRetPos?: number;
  varDecl?: boolean;
  /**
   * Set on varDecl entries whose RHS is an `as Type` or `<Type>` cast.
   * Apply consults `infer.honorAsCasts` (default ON) to decide whether to
   * skip the observed-type annotation — letting the user's explicit cast
   * stand instead of an over-eager structural type from runtime walking.
   */
  hasAsCast?: boolean;
  /**
   * Set on observations from `__tscptr__.ret` wraps around invocations of a
   * callback parameter inside its function's body — e.g. `render(title)`
   * inside `Card({title, render})`. The recorded value is the callback's
   * return value; `paramReturnMember` names which parameter (or
   * destructured property) was invoked. Phase-2 cross-ref uses these to
   * substitute `=> unknown` in the param's emitted function type with the
   * observed return type.
   */
  paramReturn?: boolean;
  paramReturnMember?: string;
}

/**
 * When ts-capture falls back to a coarse / generic emit because it
 * couldn't observe the precise shape, the entry is tagged with a reason.
 * Apply emits an in-source marker comment (e.g.
 * `/* @ts-capture:generic-fn *​/`) when `infer.emitDiagnosticComments`
 * is enabled, so reviewers can distinguish confident emits from
 * fallbacks. Default vocabulary is intentionally small; new tags are
 * additive only (vocabulary is part of the public surface).
 */
export type ApproximationReason =
  | "generic-fn" // function value observed; no specific signature available
  | "shape-capped"; // object / array shape exceeded maxAnnotationChars; fell back to coarse type

export type DiscoveredType = [string | undefined, SourceLocation | undefined, ApproximationReason?];

export type CollectedTypeEntry = [
  string, // filename
  number, // offset
  DiscoveredType[], // discovered types
  ExtraOptions,
];

export type CollectedTypeInfo = CollectedTypeEntry[];

export interface Diagnostic {
  type: "depth-exceeded" | "collection-error";
  message: string;
  filename?: string;
  position?: number;
}

export interface CollectorOptions {
  maxDepth?: number;
  /**
   * Literal-type options. Default: undefined (no literal emission). Pass
   * to enable e.g. `literalString: true` so short string values get
   * recorded as `'"hello"'` instead of `'string'`. Pair with
   * `infer.literal.*` config flags at apply-time.
   */
  literalOptions?: LiteralOptions;
}

export interface CollectionContext {
  record(name: string, value: unknown, pos: number, filename: string, opts: ExtraOptions): void;
  track<T>(value: T, filename: string, offset: number): T;
  registerFn(fn: Function, retPos: number, filename: string): void;
  /**
   * Register an inline function (arrow / function expression) AT its
   * evaluation site and return it. Inline arrows passed as callback
   * props or call args have no name to reach them by, so `registerFn`
   * (which takes a named-fn identifier) doesn't help. Wrapping the
   * arrow in `regFn` at the transform site captures the function value
   * AT creation time, registers it for cross-position signature
   * inference, and returns the value through.
   */
  regFn<T extends Function>(fn: T, retPos: number, filename: string): T;
  getCollectedTypes(): CollectedTypeInfo;
  diagnostics: Diagnostic[];
}

/**
 * Per-call options for `getTypeName`. Despite the name (kept for
 * backward compat — `LiteralOptions` is exported and consumed by
 * `@ts-capture/vite`), this also covers non-literal flags like
 * `captureClassHierarchy`.
 *
 * Default for every flag is "off" so the observation JSON stays in
 * today's shape unless the runtime explicitly opts in.
 */
export interface LiteralOptions {
  /** Emit string-literal types up to stringMaxLength chars. */
  literalString?: boolean;
  /** Max length of strings to emit as literals (default 16). */
  literalStringMaxLength?: number;
  /** Emit number-literal types (e.g. `42` instead of `number`). */
  literalNumber?: boolean;
  /** Emit boolean-literal types (e.g. `true` instead of `boolean`). */
  literalBoolean?: boolean;
  /**
   * Capture the prototype chain when emitting a class-instance type.
   * Encoded inline in the type name as a marker comment with the chain
   * (e.g. Cat with bases Mammal,Animal). Apply-time
   * `infer.rewriteCommonBase` then collapses observed unions of derived
   * classes (e.g. `Cat | Dog`) to their most-specific shared ancestor
   * (`Mammal`).
   *
   * The chain comment is always stripped at apply time, so leaving
   * `infer.rewriteCommonBase` off (the default) just collapses to the
   * most-derived class name — same as today.
   */
  captureClassHierarchy?: boolean;
  /**
   * Maximum size in characters of a serialized type name. When the
   * walk produces a string longer than this, fall back to a coarse
   * type that captures the kind without the shape:
   *   - plain object  → `Record<string, unknown>`
   *   - class instance → the constructor name
   *   - array         → `unknown[]`
   *   - function      → `(...args: unknown[]) => unknown`
   * Default: 4096. Deeply-recursive wide objects (Redux stores, React
   * Hook Form's `_props.current.control`, etc.) could otherwise produce
   * 500KB single-line annotations that break the downstream TS/SWC
   * parser.
   */
  maxAnnotationChars?: number;
}
