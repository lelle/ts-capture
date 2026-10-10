import fs from "node:fs";
import path from "node:path";

import type { CollectedTypeInfo } from "../type-collector.js";
import type { VerifyEntry } from "../verify.js";

import { getProgram } from "../compiler-helper.js";
import { verifyTypes } from "../verify.js";

/**
 * `ts-capture verify <types.json> --project <tsconfig.json> [--threshold=N]` —
 * compare runtime observations with the type TypeScript has at each observed
 * position, printing every mismatch with its location. Exits 2 when a
 * `--threshold` is set and the match ratio is below it.
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

  const mismatches = report.entries
    .filter((e) => e.verdict === "mismatch")
    .sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  if (mismatches.length > 0) process.stdout.write("\n");
  for (const m of mismatches) {
    process.stdout.write(
      `${location(m)}  ${m.name ?? ""}\n  declared  ${m.declared}\n  observed  ${m.observed.join(" | ")}\n`,
    );
  }

  const t = report.totals;
  process.stdout.write(
    `\n${t.total} observed positions: ${t.match} match, ${t.mismatch} mismatch, ` +
      `${t.unverifiable} unverifiable, ${t.noDeclaration} without a declaration.\n`,
  );
  const byReason = countByReason(report.entries.filter((e) => e.verdict === "unverifiable"));
  if (byReason.length > 0) process.stdout.write(`  unverifiable: ${byReason.join(", ")}\n`);

  if (threshold !== null) {
    const verifiable = t.match + t.mismatch;
    const matchRatio = verifiable > 0 ? t.match / verifiable : 1;
    if (matchRatio < threshold) {
      process.stderr.write(
        `\nMatch ratio ${(matchRatio * 100).toFixed(2)}% below threshold ${(threshold * 100).toFixed(2)}%\n`,
      );
      process.exit(2);
    }
  }
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
