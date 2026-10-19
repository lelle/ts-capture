import type ts from "typescript";

import type { ApplyTypesOptions } from "./contract.js";
import type { CollectedTypeInfo } from "./type-collector.js";

import { applyTypesToFileCst as applyOneFile } from "./apply-types-cst.js";

/** @deprecated Use `annotate`, which runs the same applier and also returns what it skipped. */
export function applyTypesToFile(
  source: string,
  typeInfo: CollectedTypeInfo,
  options: ApplyTypesOptions,
  program?: ts.Program,
): string {
  return applyOneFile(source, typeInfo, options, program);
}

/** @deprecated Use `annotate`, which runs the same applier and also returns what it skipped. */
export function applyTypesToFileCst(
  source: string,
  typeInfo: CollectedTypeInfo,
  options: ApplyTypesOptions,
  program?: ts.Program,
): string {
  return applyOneFile(source, typeInfo, options, program);
}

/** @deprecated Use `annotateProject`, which groups the entries by file and annotates each. */
export function applyTypesToFiles(
  typeInfo: CollectedTypeInfo,
  _options: ApplyTypesOptions = {},
): Map<string, { source: string; typeInfo: CollectedTypeInfo }> {
  const grouped = new Map<string, CollectedTypeInfo>();
  for (const entry of typeInfo) {
    const file = entry[0];
    const existing = grouped.get(file);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(file, [entry]);
    }
  }

  const result = new Map<string, { source: string; typeInfo: CollectedTypeInfo }>();
  for (const [file, entries] of grouped) {
    result.set(file, { source: file, typeInfo: entries });
  }
  return result;
}
