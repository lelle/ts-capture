import type { ApproximationReason, DiscoveredType } from "./collector-contract.js";
import type { InferOptions } from "./configuration.js";

/**
 * Pick the dominant approximation reason from a types-array (the entry's
 * per-observation reason tags). Currently first-wins: the first
 * observation with a reason determines the marker. Future refinement
 * (priority order: shape-capped > generic-fn > …) when the vocabulary
 * grows.
 */
function getDominantApproximationReason(types: DiscoveredType[]): ApproximationReason | null {
  for (const t of types) {
    const reason = t[2];
    if (reason) return reason;
  }
  return null;
}

/**
 * Build the marker-comment suffix for the apply-emit path.
 * Returns `" /* @ts-capture:<reason> *​/"` when the entry carries an
 * approximation reason AND the user opted in via
 * `infer.emitDiagnosticComments`; empty string otherwise. Shared
 * between `applyTypesToFile` (offset-based) and `applyTypesToFileCst`
 * (AST-based) so both paths emit byte-identical markers.
 */
export function buildDiagnosticMarkerSuffix(types: DiscoveredType[], infer: InferOptions): string {
  if (!infer.emitDiagnosticComments) return "";
  const reason = getDominantApproximationReason(types);
  if (reason === null) return "";
  return ` /* @ts-capture:${reason} */`;
}
