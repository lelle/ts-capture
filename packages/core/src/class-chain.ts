import type { InferOptions } from "./configuration.js";

/**
 * Class-hierarchy chain marker emitted by the runtime when
 * `LiteralOptions.captureClassHierarchy` is on. The format is
 * `"ClassName /` `* @sa:Base1|Base2 *` `/"` (the `@sa` comment is
 * unique enough that real source comments won't false-match). Empty
 * chain (`@sa:`) is valid — it means "this is a class-instance
 * observation, but the class has no non-Object ancestor".
 */
const CLASS_CHAIN_RE = /^([^\s/]+)\s*\/\*\s*@sa:([^*]*)\*\/\s*$/;

interface ClassWithChain {
  name: string;
  bases: string[];
}

function parseClassChain(type: string): ClassWithChain | null {
  const m = CLASS_CHAIN_RE.exec(type);
  if (!m) return null;
  const bases = m[2]
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { name: m[1], bases };
}

/**
 * Given a list of class observations (each with a chain), find the
 * most-specific class name that appears in EVERY observation's full
 * chain (`[name, ...bases]`). Returns null if no shared ancestor exists
 * (e.g. observations from completely unrelated hierarchies).
 *
 * "Most specific" = appears earliest in the first chain — chains are
 * ordered most-derived first, so the earliest shared name is the
 * deepest ancestor common to all observations.
 */
function findMostSpecificCommonBase(observations: ClassWithChain[]): string | null {
  if (observations.length === 0) return null;
  if (observations.length === 1) return observations[0].name;
  const chains = observations.map((o) => [o.name, ...o.bases]);
  const [first, ...rest] = chains;
  for (const candidate of first) {
    if (rest.every((c) => c.includes(candidate))) return candidate;
  }
  return null;
}

/**
 * Final-pass defense against `@sa:` markers leaking into the apply
 * output. Some shapes (e.g. a single observation of an object type
 * with a class-typed value) flow through paths that don't call
 * `rewriteCommonBase` / `mergeKeyValues`, so the marker survives. This
 * regex-strips every `/​* @sa:... *​/` occurrence from the final
 * type string regardless of nesting.
 *
 * Safe because the marker shape (whitespace + comment + `@sa:` +
 * pipe-separated identifiers + comment close) is unique enough that
 * collateral damage to legitimate user comments is implausible — the
 * runtime is the only producer of these markers, and it always emits
 * the same shape.
 */
// Leading whitespace is bounded to `\s?` (not `\s*`): the marker is always
// emitted as `<name> /* @sa:... */` with a single separating space
// (type-signature.ts), so one optional space suffices — and it avoids the
// super-linear scan an unbounded leading quantifier would create.
const ANY_CHAIN_MARKER_RE = /\s?\/\*\s*@sa:[^*]*\*\//g;
export function stripAllChainMarkers(type: string): string {
  return type.replace(ANY_CHAIN_MARKER_RE, "");
}

/**
 * Collapse a list of already-deduped types to a shared
 * ancestor: when 2+ class observations share an ancestor,
 * collapse them to that ancestor; pass everything else through unchanged.
 *
 * Always strips chain markers from the returned strings — even when
 * `infer.rewriteCommonBase` is OFF — because the markers are an internal
 * encoding and must never leak into the apply output. Leaving the flag
 * off just means the collapse step is skipped (each class observation
 * keeps its most-derived name); the markers are still cleaned up.
 */
export function rewriteCommonBase(types: string[], infer: InferOptions): string[] {
  const classObservations: ClassWithChain[] = [];
  const otherTypes: string[] = [];
  for (const t of types) {
    const parsed = parseClassChain(t);
    if (parsed) classObservations.push(parsed);
    else otherTypes.push(t);
  }

  if (classObservations.length === 0) return otherTypes;

  // Dedup class observations by name (same class name → same chain by
  // construction at runtime; keep the first).
  const dedupedClasses = new Map<string, ClassWithChain>();
  for (const obs of classObservations) {
    if (!dedupedClasses.has(obs.name)) dedupedClasses.set(obs.name, obs);
  }
  const uniqueClasses = [...dedupedClasses.values()];

  if (!infer.rewriteCommonBase || uniqueClasses.length < 2) {
    return [...uniqueClasses.map((c) => c.name), ...otherTypes];
  }

  const base = findMostSpecificCommonBase(uniqueClasses);
  if (base === null) {
    return [...uniqueClasses.map((c) => c.name), ...otherTypes];
  }
  return [base, ...otherTypes];
}
