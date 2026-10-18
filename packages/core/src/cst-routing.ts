import type { InferOptions } from "./configuration.js";
import type { ApplySkipReason, ApplyTelemetry } from "./contract.js";
import type { CstSiteIndex, VarDeclSite } from "./cst-site-index.js";
import type { CollectedTypeInfo } from "./type-collector.js";

import { decideVarDeclSite } from "./annotation-eligibility.js";

// Entry routing for the AST-aware applier: given the offset-keyed
// `CstSiteIndex` and the collected observations, decide which entries have a
// site to annotate. All the skip guards (rhsIsFunction, generic context,
// union-producing / opaque initializers, existing-type idempotency) live here,
// and an entry at no site is a skip of its own.

export type CstEntryKind = "param" | "returnType" | "varDecl" | "thisType";

export interface RoutedEntry {
  entry: CollectedTypeInfo[number];
  kind: CstEntryKind;
}

export interface RoutedEntries {
  /** CST-eligible entries, deduped by `(file, pos, kind)`. */
  eligible: Map<string, RoutedEntry>;
}

/**
 * Classify every observation into a CST-eligible site or a skip. `telemetry`,
 * when present, is incremented in place and receives the skips.
 */
export function routeEntries(
  typeInfo: CollectedTypeInfo,
  index: CstSiteIndex,
  infer: InferOptions,
  telemetry?: ApplyTelemetry,
): RoutedEntries {
  const {
    ignoredRanges,
    thisTypeSites,
    varDeclSites,
    returnTypeSites,
    paramSites,
    typedParamEnds,
  } = index;
  const cstEligible: RoutedEntry[] = [];
  const skip = (entry: CollectedTypeInfo[number], reason: ApplySkipReason, detail?: string) => {
    if (!telemetry) return;
    if (reason === "already-annotated") telemetry.idempotent++;
    if (reason === "no-site") telemetry.positionMismatch++;
    telemetry.skipped.push({
      pos: entry[1],
      reason,
      observed: [...new Set(entry[2].map(([name]) => name).filter(Boolean))].join(" | "),
      ...(detail ? { detail } : {}),
    });
  };

  for (const entry of typeInfo) {
    const [, pos, , opts] = entry;
    // Neither is input to apply, so neither is counted, as in `apply-types.ts`:
    // a `paramReturn` record says what calling the parameter returned, not
    // what the parameter is, and a written type is observed only for `verify`.
    if (opts?.paramReturn) continue;
    if (opts?.annotated) continue;
    if (telemetry) telemetry.totalEntries++;
    if (ignoredRanges.some(([s, e]) => pos >= s && pos < e)) {
      skip(entry, "ignored");
      continue;
    }
    if (opts?.thisType) {
      const site = thisTypeSites.get(pos);
      if (site) {
        cstEligible.push({ entry, kind: "thisType" });
      } else {
        skip(entry, "no-site");
      }
      continue;
    }
    if (opts?.varDecl) {
      const site = varDeclSites.get(pos);
      // Eligibility decision shared with the offset-based applier — see
      // annotation-eligibility.ts. The AST index supplies the per-site facts.
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
      } else if (verdict === "no-site") {
        skip(entry, "no-site");
      } else if (verdict === "idempotent") {
        skip(entry, "already-annotated");
      } else if (verdict === "outer-conflict") {
        skip(entry, "kept-existing", outerConflictDetail(site!));
      } else if (verdict === "one-branch") {
        skip(entry, "no-information", "one branch of the initializer observed");
      } else if (verdict === "only-undefined") {
        skip(entry, "no-information", "only `undefined` observed");
      }
      continue;
    }
    if (opts?.returnType) {
      const site = returnTypeSites.get(pos);
      // Bypassed when `infer.ignoreExistingTypes` is on.
      if (site && site.hasReturnType && !infer.ignoreExistingTypes) {
        skip(entry, "already-annotated");
        continue;
      }
      if (site) {
        cstEligible.push({ entry, kind: "returnType" });
      } else {
        skip(entry, "no-site");
      }
      continue;
    }
    // Plain param entry.
    if (typedParamEnds.has(pos)) {
      skip(entry, "already-annotated");
    } else if (paramSites.has(pos)) {
      cstEligible.push({ entry, kind: "param" });
    } else {
      skip(entry, "no-site");
    }
  }

  // Dedup CST-eligible entries by (file, pos, kind).
  //
  // Keyed on the routed `kind`, not the raw opts object. One position can
  // host different kinds legitimately (a paren-less arrow's param and its
  // return annotation share the param-end offset), so pos alone is too
  // coarse — but the whole opts object is too fine: incidental fields
  // (`fnRetPos`, `async`) split one site into several, and each
  // then emits its own annotation, producing `x: string: string`. The offset
  // applier keys the same way and for the same reason.
  const eligible = new Map<string, RoutedEntry>();
  for (const item of cstEligible) {
    const [file, pos, types, opts] = item.entry;
    const k = `${file}\x00${pos}\x00${item.kind}`;
    const existing = eligible.get(k);
    if (existing) {
      existing.entry[2].push(...types);
    } else {
      eligible.set(k, { entry: [file, pos, [...types], opts], kind: item.kind });
    }
  }

  return { eligible };
}

function outerConflictDetail(site: VarDeclSite): string {
  if (site.rhsIsFunction) return "the initializer is a function with its own types";
  if (site.hasInitializerTypeArguments) return "the initializer passes type arguments";
  return "inside a generic function";
}
