import fs from "node:fs";
import path from "node:path";

import type { CollectedTypeInfo } from "../type-collector.js";
import type { VerifyEntry, VerifyVerdict } from "../verify.js";

import { getProgram } from "../compiler-helper.js";
import { verifyTypes } from "../verify.js";

/**
 * `ts-capture verify <types.json> --project <tsconfig.json> [--threshold=N]` —
 * compare runtime observations with the type TypeScript has at each observed
 * position, printing every mismatch with its location; written types and
 * inferred ones in sections of their own when any written type was observed.
 * Exits 2 when a `--threshold` is set and the match ratio is below it,
 * counted over the written types when there are any.
 */
export function cmdVerify(args: string[]) {
  const positional = args.filter((a) => !a.startsWith("-") && a !== "verify");
  const jsonPath = positional[0];
  if (!jsonPath) {
    process.stderr.write("Error: missing types.json argument\n");
    process.exit(1);
  }

  const projectArg =
    args.find((a) => a.startsWith("--project="))?.slice("--project=".length) ??
    args[args.indexOf("--project") + 1];
  if (!projectArg) {
    process.stderr.write("Error: --project <tsconfig.json> required\n");
    process.exit(1);
  }
  const thresholdRaw = args.find((a) => a.startsWith("--threshold="))?.slice("--threshold=".length);
  const threshold = thresholdRaw ? parseFloat(thresholdRaw) : null;

  const typesResolved = path.resolve(jsonPath);
  const tsConfigResolved = path.resolve(projectArg);

  const typeInfo = JSON.parse(fs.readFileSync(typesResolved, "utf-8")) as CollectedTypeInfo;
  const program = getProgram({
    tsConfig: tsConfigResolved,
    rootDir: path.dirname(tsConfigResolved),
  });
  if (!program) {
    throw new Error(`Could not create program from ${tsConfigResolved}`);
  }

  const report = verifyTypes(typeInfo, program);
  const written = report.entries.filter((e) => e.opts?.annotated);

  if (written.length > 0) {
    writeSection("Written types", written);
    writeSection(
      "Inferred types",
      report.entries.filter((e) => !e.opts?.annotated),
    );
  } else {
    if (report.entries.some((e) => e.verdict === "mismatch")) process.stdout.write("\n");
    writeMismatches(report.entries);
    process.stdout.write(
      `\n${report.entries.length} observed positions: ${summary(report.entries)}\n`,
    );
    writeUnverifiable(report.entries);
    process.stderr.write(
      "\nNo observations of written types, so no type you wrote was checked. " +
        "Run the tests with TS_CAPTURE_OBSERVE_ANNOTATED=1 to observe them.\n",
    );
  }

  if (threshold !== null) {
    // A CI gate on written types fails for the reason the check exists; mixed
    // with inferred positions, one wrong written type is diluted to nothing.
    const counted = written.length > 0 ? written : report.entries;
    const match = countOf(counted, "match");
    const verifiable = match + countOf(counted, "mismatch");
    const matchRatio = verifiable > 0 ? match / verifiable : 1;
    if (matchRatio < threshold) {
      process.stderr.write(
        `\nMatch ratio${written.length > 0 ? " of written types" : ""} ` +
          `${(matchRatio * 100).toFixed(2)}% below threshold ${(threshold * 100).toFixed(2)}%\n`,
      );
      process.exit(2);
    }
  }
}

function writeSection(title: string, entries: VerifyEntry[]): void {
  process.stdout.write(`\n${title} (${entries.length} checked)\n`);
  writeMismatches(entries);
  process.stdout.write(`  ${summary(entries)}\n`);
  writeUnverifiable(entries);
}

function writeMismatches(entries: VerifyEntry[]): void {
  const mismatches = entries
    .filter((e) => e.verdict === "mismatch")
    .sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  for (const m of mismatches) {
    process.stdout.write(
      `${location(m)}  ${m.name ?? ""}\n  declared  ${m.declared}\n  observed  ${m.observed.join(" | ")}\n`,
    );
  }
}

function summary(entries: VerifyEntry[]): string {
  return (
    `${countOf(entries, "match")} match, ${countOf(entries, "mismatch")} mismatch, ` +
    `${countOf(entries, "unverifiable")} unverifiable, ` +
    `${countOf(entries, "no-declaration")} without a declaration.`
  );
}

function writeUnverifiable(entries: VerifyEntry[]): void {
  const byReason = countByReason(entries.filter((e) => e.verdict === "unverifiable"));
  if (byReason.length > 0) process.stdout.write(`  unverifiable: ${byReason.join(", ")}\n`);
}

function countOf(entries: VerifyEntry[], verdict: VerifyVerdict): number {
  return entries.filter((e) => e.verdict === verdict).length;
}

function location(entry: VerifyEntry): string {
  const file = path.relative(process.cwd(), entry.file) || entry.file;
  return entry.line === undefined
    ? `${file}:pos ${entry.pos}`
    : `${file}:${entry.line}:${entry.column}`;
}

/** `"98 declared any, 6 complex declared type"`, most frequent first. */
function countByReason(entries: VerifyEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const e of entries)
    counts.set(e.reason ?? "unknown", (counts.get(e.reason ?? "unknown") ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${n} ${reason}`);
}
