import path from "node:path";

import { getProgram } from "../compiler-helper.js";
import { typeCoverage } from "../type-coverage.js";

/** `ts-capture coverage <tsconfig.json>` — report type coverage percentage. */
export function cmdCoverage(args: string[]) {
  const tsConfigPath = args.find((a) => !a.startsWith("-") && a !== "coverage");
  if (!tsConfigPath) {
    process.stderr.write("Error: missing tsconfig.json argument\n");
    process.exit(1);
  }

  const resolved = path.resolve(tsConfigPath);
  const program = getProgram({ tsConfig: resolved, rootDir: path.dirname(resolved) });
  if (!program) {
    throw new Error(`Could not create program from ${resolved}`);
  }

  const result = typeCoverage(program);
  process.stdout.write(
    `Type coverage: ${result.percentage.toFixed(1)}% (${result.knownTypes}/${result.totalTypes})\n`,
  );
}
