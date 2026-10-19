import ts from "typescript";

import type { CollectedTypeInfo, ExtraOptions } from "./type-collector.js";

import { typeJudge, type Verdict } from "./type-judge.js";

export { isCompatible } from "./type-judge.js";

export type VerifyVerdict = Verdict;

export interface VerifyEntry {
  file: string;
  pos: number;
  /** One-based, at the declaration name or the return-type position. Absent when the file is not in the program. */
  line?: number;
  column?: number;
  name?: string;
  declared: string | null;
  observed: string[];
  verdict: VerifyVerdict;
  reason?: string;
  opts: ExtraOptions;
}

export interface VerifyReport {
  entries: VerifyEntry[];
  totals: {
    total: number;
    match: number;
    mismatch: number;
    unverifiable: number;
    noDeclaration: number;
  };
}

/**
 * Compare runtime-observed types with the type TypeScript has at each observed
 * position: the written type where there is one, which is observed only with
 * `observeAnnotated`, and otherwise what TypeScript infers there.
 *
 * The comparison is `typeJudge`'s: text first, then the checker. Honest by
 * design: `unverifiable`, with a reason, wherever neither can decide.
 */
export function verifyTypes(typeInfo: CollectedTypeInfo, program: ts.Program): VerifyReport {
  const judge = typeJudge({ kind: "program", program }, typeInfo);
  const entries: VerifyEntry[] = [];
  const totals = {
    total: typeInfo.length,
    match: 0,
    mismatch: 0,
    unverifiable: 0,
    noDeclaration: 0,
  };

  for (const entry of typeInfo) {
    const [file, pos, observedTuples, opts] = entry;
    const { verdict, reason, declared, line, column, name } = judge.fits(entry);
    const found = verdict !== "no-declaration";
    entries.push({
      file,
      pos,
      ...(line !== undefined ? { line, column } : {}),
      ...(name !== undefined ? { name } : {}),
      declared,
      observed: found ? observedTuples.map(([t]) => t).filter((t): t is string => Boolean(t)) : [],
      verdict,
      reason,
      opts,
    });
    if (verdict === "no-declaration") totals.noDeclaration++;
    else totals[verdict]++;
  }

  return { entries, totals };
}
