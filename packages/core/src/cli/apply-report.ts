import type { ApplySkip, ApplySkipReason, ApplyTelemetry, ApplyWrite } from "../contract.js";

/** Where in the file's source a site is, and what to call it. */
interface Location {
  file: string;
  line: number;
  column: number;
  name: string;
}

/** A skip with the place it happened resolved against the file's source. */
export type LocatedSkip = ApplySkip & Location;

/** A written type with its place resolved against the file's source. */
export type LocatedWrite = ApplyWrite & Location;

// Reasons that leave an observation unused. The rest are positions where the
// code already says as much or more, so nothing is lost by writing nothing.
const NOT_WRITTEN: Array<{ reason: ApplySkipReason; heading: string; brief: string }> = [
  { reason: "type-error", heading: "Would add a type error", brief: "would add a type error" },
  {
    reason: "no-information",
    heading: "Carries no type information",
    brief: "with no type information",
  },
  {
    reason: "out-of-scope",
    heading: "Refers to a type this file cannot name",
    brief: "naming a type out of scope",
  },
  {
    reason: "contradiction",
    heading: "Falls outside the type already there",
    brief: "outside the existing type",
  },
  {
    reason: "no-site",
    heading: "No place to write it - has the code changed since the run?",
    brief: "at no place for a type",
  },
];

const MESSAGE_LIMIT = 200;

/**
 * Where a skipped site is, and what to call it. `pos` is where the annotation
 * would go — just after a name, or just after a parameter list.
 */
export function locateSite<T extends ApplySkip | ApplyWrite>(
  skip: T,
  file: string,
  source: string,
): T & Location {
  const named = /([A-Za-z_$][\w$]*)\??\s*$/.exec(source.slice(0, skip.pos));
  const start = named ? named.index : skip.pos;
  const before = source.slice(0, start);
  const lineStart = before.lastIndexOf("\n") + 1;
  return {
    ...skip,
    file,
    line: before.split("\n").length,
    column: start - lineStart + 1,
    name: named ? named[1] : "return type",
  };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The lines every run prints: what was written, and whether anything was left. */
export function summaryLines(
  telemetry: ApplyTelemetry,
  filesChanged: number,
  skips: LocatedSkip[],
  pointAtReport: boolean,
): string[] {
  const lines = [
    `apply: ${plural(telemetry.emitted, "annotation")} written in ${plural(filesChanged, "file")}.`,
  ];
  const notWritten = notWrittenLine(skips, pointAtReport);
  if (notWritten) lines.push(`       ${notWritten}`);
  return lines;
}

/** `N observed positions not written (…)`, or undefined when there are none. */
export function notWrittenLine(skips: LocatedSkip[], pointAtReport: boolean): string | undefined {
  const parts: string[] = [];
  let total = 0;
  for (const { reason, brief } of NOT_WRITTEN) {
    const count = skips.filter((s) => s.reason === reason).length;
    if (count === 0) continue;
    total += count;
    parts.push(`${count} ${brief}`);
  }
  if (total === 0) return undefined;
  return (
    `${plural(total, "observed position")} not written (${parts.join(", ")})` +
    (pointAtReport ? " - see --report." : ".")
  );
}

/**
 * The `--report` body: every unused observation with its reason, then the
 * counts that cost nothing. `display` turns a file's path into what is shown.
 */
export function reportLines(
  telemetry: ApplyTelemetry,
  skips: LocatedSkip[],
  display: (file: string) => string = (file) => file,
): string[] {
  const lines: string[] = [];
  const notWritten = NOT_WRITTEN.map((group) => ({
    ...group,
    skips: skips.filter((s) => s.reason === group.reason),
  })).filter((group) => group.skips.length > 0);

  if (notWritten.length > 0) {
    const total = notWritten.reduce((sum, group) => sum + group.skips.length, 0);
    lines.push("", `Observed but not written (${total})`);
    for (const group of notWritten) {
      lines.push("", `  ${group.heading} (${group.skips.length})`);
      for (const skip of group.skips) {
        lines.push(`    ${display(skip.file)}:${skip.line}:${skip.column}  ${skip.name}`);
        if (skip.observed) lines.push(`      observed  ${skip.observed}`);
        if (skip.rule) lines.push(`      rule  ${skip.rule}`);
        if (skip.diagnostic) {
          const { code, message, file, line } = skip.diagnostic;
          const text =
            message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT)}…` : message;
          lines.push(`      TS${code} at ${display(file)}:${line}: ${text}`);
        }
        if (skip.detail) lines.push(`      ${skip.detail}`);
      }
    }
  }

  const redundant = skips.filter((s) => s.reason === "redundant").length;
  const keptExisting = skips.filter((s) => s.reason === "kept-existing").length;
  const alreadyAnnotated = skips.filter((s) => s.reason === "already-annotated").length;
  const ignored = skips.filter((s) => s.reason === "ignored").length;
  const leftToTypeScript = skips.filter((s) => s.reason === "left-to-typescript").length;
  const nothingToAdd = redundant + keptExisting + alreadyAnnotated + ignored + leftToTypeScript;
  if (nothingToAdd > 0) {
    lines.push("", `Nothing to add (${nothingToAdd})`);
    if (redundant > 0) lines.push(`  ${redundant} already inferred by TypeScript`);
    if (alreadyAnnotated > 0) lines.push(`  ${alreadyAnnotated} already annotated`);
    if (keptExisting > 0) lines.push(`  ${keptExisting} where the code already says more`);
    if (leftToTypeScript > 0) lines.push(`  ${leftToTypeScript} left for TypeScript to infer`);
    if (ignored > 0) lines.push(`  ${ignored} marked @ts-capture-ignore`);
  }
  return lines;
}
