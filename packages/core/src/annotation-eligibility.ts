// Shared annotation-eligibility decision, consumed by both appliers so the
// offset-based and AST-based paths agree on which positions to annotate, skip,
// or delegate. Pure: given a site's facts + the observation, returns the
// verdict.

/** The per-site facts every var-decl eligibility rule consults. */
export interface VarDeclFacts {
  /**
   * Any outer-annotation-conflict reason: the RHS is a function expression,
   * the initializer has explicit type arguments, or an enclosing function is
   * generic. All three mean the same thing — don't add an outer annotation
   * here — so they collapse into one signal. The CST path ORs its three
   * granular flags; the offset path reads its single `skip` set.
   */
  outerAnnotationSkip: boolean;
  isUnionProducingInitializer: boolean;
  hasOpaqueInitializer: boolean;
  hasType: boolean;
}

export type VarDeclVerdict =
  | "annotate" // emit the annotation here
  | "drop" // never annotate here (either applier)
  | "idempotent" // already typed — skip and count as idempotent
  | "delegate"; // site unknown to this applier — hand to the offset path

/**
 * Decide a var-decl annotation site. `facts` is undefined when the applier has
 * no site record for the position (AST path: not in the index). `firstObservationIsUndefined`
 * is whether the sole observation's type name is `"undefined"`.
 */
export function decideVarDeclSite(
  facts: VarDeclFacts | undefined,
  observationCount: number,
  firstObservationIsUndefined: boolean,
  ignoreExistingTypes: boolean,
): VarDeclVerdict {
  // No site record — only the offset path can place this; delegate.
  if (!facts) return "delegate";
  // Outer-annotation conflict (function RHS / type-args / generic context):
  // an outer annotation here is redundant or contravariantly incompatible.
  if (facts.outerAnnotationSkip) return "drop";
  // Union-producing initializer (??, ||, ternary, ?., arr.find(...)) with a
  // single observation: it came from one branch, so annotating rejects the
  // other branch's reachable type. Let TS infer the union.
  if (facts.isUnionProducingInitializer && observationCount === 1) return "drop";
  // Sole-undefined observation on an opaque initializer (call, await, member
  // access): static return is almost certainly `T | undefined`; `: undefined`
  // would reject the non-undefined branch.
  if (facts.hasOpaqueInitializer && observationCount === 1 && firstObservationIsUndefined) {
    return "drop";
  }
  // Already-typed binding — idempotent skip, unless ignoreExistingTypes is on.
  if (facts.hasType && !ignoreExistingTypes) return "idempotent";
  return "annotate";
}

/**
 * Suppress a structural-object annotation on an `Array.prototype`-callback arrow
 * param/return: TS contextually types these from the array's element type, so a
 * multi-hundred-char structural shape at the call site is pure noise. Primitive
 * or named annotations (no `{`) pass through. Shared by both appliers — each
 * supplies whether the position is such a callback arrow; the structural test
 * lives here.
 */
export function suppressArrayCallbackStructural(
  isArrayCallbackArrowParam: boolean,
  emitted: string,
): boolean {
  return isArrayCallbackArrowParam && emitted.includes("{");
}
