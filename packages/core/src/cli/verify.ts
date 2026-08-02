import fs from "node:fs";
import path from "node:path";

import type { CollectedTypeInfo } from "../type-collector.js";

import { getProgram } from "../compiler-helper.js";
import { verifyTypes } from "../verify.js";

/**
 * `ts-capture verify <types.json> --project <tsconfig.json> [--threshold=N]` —
 * compare runtime observations to declared types, printing mismatches grouped
 * by file. Exits 2 when a `--threshold` is set and the match ratio is below it.
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

  // Print mismatches grouped by file
  const byFile = new Map<string, typeof report.entries>();
  for (const e of report.entries) {
    if (e.verdict !== "mismatch") continue;
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }
  for (const [file, mismatches] of [...byFile.entries()].sort()) {
    process.stdout.write(`\n${file}\n`);
    for (const m of mismatches) {
      process.stdout.write(
        `  pos ${m.pos}: declared=${m.declared}  observed=[${m.observed.join(", ")}]\n`,
      );
    }
  }

  const t = report.totals;
  process.stdout.write(
    `\nTotal: ${t.total}  match=${t.match}  mismatch=${t.mismatch}  unverifiable=${t.unverifiable}  no-decl=${t.noDeclaration}\n`,
  );

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
