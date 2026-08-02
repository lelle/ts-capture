/**
 * Declarative member-filter abstraction.
 *
 * `computeAnnotationTypeString` in `apply-types.ts` historically grew a
 * chain of ad-hoc `.filter()` calls (optional-binding strip,
 * ...). Reading the chain end-to-end made it hard to reason about which
 * rule fires when, and harder to reason about whether two rules might
 * be redundant.
 *
 * This module ports the chain to two declarative shapes:
 *
 *   - `Priority` — competitor-aware. Drops `low` members iff at least
 *     one `high` member is also present. Mirrors TypeScript's
 *     `removeLowPriorityInferences` in
 *     `src/services/codefixes/inferFromUsage.ts:994`.
 *   - `UnconditionalFilter` — drops every member matching the
 *     predicate, regardless of what else is in the set. Useful for
 *     context-gated rules (e.g. "in optional-binding position, drop
 *     undefined").
 *
 * Caller composes a list of each, runs through `applyMemberFilters`.
 * Filters apply unconditional drops first (since they may eliminate the
 * "high" member of a later priority), then iterate over priorities.
 *
 * Out of scope (the issue's "not type-content rules" carve-out): AST-
 * geometry guards (offset validation), parseability checks, the
 * verify-oracle integration.
 */

export interface Priority {
  /** Human-readable name for debugging / commit-message provenance. */
  name: string;
  /**
   * Members the rule wants to KEEP. The rule fires only when at least
   * one member matches `high`.
   */
  high: (t: string) => boolean;
  /** Members the rule DROPS when the rule fires. */
  low: (t: string) => boolean;
}

export interface UnconditionalFilter {
  /** Human-readable name. */
  name: string;
  /** Members matching this predicate are dropped unconditionally. */
  drop: (t: string) => boolean;
}

/**
 * Apply a sequence of filters and priorities to a list of union-member
 * strings. Returns a new array — input is not mutated.
 *
 * Unconditional filters run first because they may eliminate the
 * "high" member of a later priority (and the priority should reflect
 * the post-unconditional state, not the pre-state).
 */
export function applyMemberFilters(
  members: readonly string[],
  filters: readonly UnconditionalFilter[],
  priorities: readonly Priority[],
): string[] {
  let result: string[] = [...members];
  for (const f of filters) {
    result = result.filter((t) => !f.drop(t));
  }
  for (const p of priorities) {
    const hasHigh = result.some(p.high);
    if (hasHigh) {
      result = result.filter((t) => !p.low(t));
    }
  }
  return result;
}
