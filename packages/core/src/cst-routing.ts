import type { InferOptions } from "./configuration.js";
import type { ApplyTelemetry } from "./contract.js";
import type { CstSiteIndex } from "./cst-site-index.js";
import type { CollectedTypeInfo } from "./type-collector.js";

import { decideVarDeclSite } from "./annotation-eligibility.js";

// Entry routing for the AST-aware applier. Pure
// classification: given the offset-keyed `CstSiteIndex` and the collected
// observations, decide which entries the CST path can annotate directly and
// which fall through to the offset-based applier. All the skip guards
// (rhsIsFunction, generic context, union-producing / opaque initializers,
// existing-type idempotency) live here.

export type CstEntryKind = "param" | "returnType" | "varDecl" | "thisType";

export interface RoutedEntry {
  entry: CollectedTypeInfo[number];
  kind: CstEntryKind;
}

export interface RoutedEntries {
  /** CST-eligible entries, deduped by `(file, pos, opts)`. */
  eligible: Map<string, RoutedEntry>;
  /** Entries delegated to the offset-based applier. */
  passThrough: CollectedTypeInfo;
}

/**
 * Classify every observation into a CST-eligible site or the pass-through
 * delegate. `telemetry`, when present, is incremented in place
 * (`totalEntries`, `idempotent`) exactly as the inline routing did.
 */
export function routeEntries(
  typeInfo: CollectedTypeInfo,
  index: CstSiteIndex,
  infer: InferOptions,
  telemetry?: ApplyTelemetry,
): RoutedEntries {
  const { ignoredRanges, thisTypeSites, varDeclSites, returnTypeSites, paramSites } = index;
  const cstEligible: RoutedEntry[] = [];
  const passThrough: CollectedTypeInfo = [];

  for (const entry of typeInfo) {
    if (telemetry) telemetry.totalEntries++;
    const [, pos, , opts] = entry;
    // User-marked range — drop the entry entirely (apply produces
    // no output for this position, neither CST nor pass-through).
    if (ignoredRanges.some(([s, e]) => pos >= s && pos < e)) {
      continue;
    }
    if (opts?.thisType) {
      const site = thisTypeSites.get(pos);
      if (site) {
        cstEligible.push({ entry, kind: "thisType" });
      } else {
        passThrough.push(entry);
      }
      continue;
    }
    if (opts?.varDecl) {
      const site = varDeclSites.get(pos);
      // Eligibility decision shared with the offset-based applier — see
      // annotation-eligibility.ts. The AST index supplies the per-site facts;
      // a missing site delegates to the offset path's pass-through.
      const verdict = decideVarDeclSite(
        site
          ? {
              outerAnnotationSkip:
                site.rhsIsFunction || site.hasInitializerTypeArguments || site.inGenericContext,
              isUnionProducingInitializer: site.isUnionProducingInitializer,
              hasOpaqueInitializer: site.hasOpaqueInitializer,
              hasType: site.hasType,
            }
          : undefined,
        entry[2].length,
        entry[2][0]?.[0] === "undefined",
        infer.ignoreExistingTypes,
      );
      if (verdict === "annotate") {
        cstEligible.push({ entry, kind: "varDecl" });
      } else if (verdict === "delegate") {
        passThrough.push(entry);
      } else if (verdict === "idempotent") {
        if (telemetry) telemetry.idempotent++;
      }
      // "drop" → emit nothing, neither eligible nor pass-through.
      continue;
    }
    if (opts?.returnType) {
      const site = returnTypeSites.get(pos);
      // Already-typed return: AST-native idempotency (skip without
      // sending to passThrough either — the offset-based path's
      // isAlreadyApplied would also skip, so behaviour matches).
      // Bypassed when `infer.ignoreExistingTypes` is on.
      if (site && site.hasReturnType && !infer.ignoreExistingTypes) {
        if (telemetry) telemetry.idempotent++;
        continue;
      }
      if (site) {
        cstEligible.push({ entry, kind: "returnType" });
      } else {
        passThrough.push(entry);
      }
      continue;
    }
    // Plain param entry.
    if (paramSites.has(pos)) {
      cstEligible.push({ entry, kind: "param" });
    } else {
      passThrough.push(entry);
    }
  }

  // Dedup CST-eligible entries by (file, pos, opts).
  const eligible = new Map<string, RoutedEntry>();
  for (const item of cstEligible) {
    const [file, pos, types, opts] = item.entry;
    const k = `${file}\x00${pos}\x00${JSON.stringify(opts ?? null)}`;
    const existing = eligible.get(k);
    if (existing) {
      existing.entry[2].push(...types);
    } else {
      eligible.set(k, { entry: [file, pos, [...types], opts], kind: item.kind });
    }
  }

  return { eligible, passThrough };
}
