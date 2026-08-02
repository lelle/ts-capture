#!/usr/bin/env node

import { cmdApply } from "./cli/apply.js";
import { cmdApplyBundle, cmdInstrumentBundle } from "./cli/bundle.js";
import { cmdCoverage } from "./cli/coverage.js";
import { cmdInstrument } from "./cli/instrument.js";
import { cmdMerge } from "./cli/merge.js";
import { cmdVerify } from "./cli/verify.js";

const USAGE = `ts-capture — automatically add TypeScript type annotations

Usage:
  ts-capture instrument <file>  [--in-place]   Instrument a file with type tracking
  ts-capture apply <types.json> [--dry-run] [--include-tests] [--force]
                                          Apply collected types to source files
                                          --dry-run        report what would change without writing
                                          --include-tests  apply to *.spec.* / *.test.* (default: skip)
                                          --force          bypass <types.json>.applied idempotency manifest
  ts-capture merge <dir-or-files...> [--out <path>]
                                          Merge per-PID ts-capture-types-*.json dumps into a
                                          single types.json. Vitest's forks pool emits
                                          one dump per spec; merge before apply.
  ts-capture coverage <tsconfig.json>          Report type coverage percentage
  ts-capture verify <types.json> --project <tsconfig.json> [--threshold=N]
                                          Compare runtime observations to declared types
  ts-capture instrument-bundle <bundle.js> [--out <path>]
                                          Instrument a bundled JS artefact
  ts-capture apply-bundle <observations.json> --map <bundle.js.map> [--bundle <bundle.js>]
                                          Translate bundle observations to source positions
                                          and apply types
  ts-capture --help                            Show this help message
`;

function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith("-"));
  const flags = new Set(args.filter((a) => a.startsWith("-")));

  if (!command || flags.has("--help") || flags.has("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  try {
    switch (command) {
      case "instrument":
        cmdInstrument(args, flags);
        break;
      case "apply":
        cmdApply(args, flags).catch((err) => {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        });
        break;
      case "merge":
        cmdMerge(args);
        break;
      case "coverage":
        cmdCoverage(args);
        break;
      case "verify":
        cmdVerify(args);
        break;
      case "instrument-bundle":
        cmdInstrumentBundle(args);
        break;
      case "apply-bundle":
        cmdApplyBundle(args).catch((err) => {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        });
        break;
      default:
        process.stderr.write(`Error: unknown command "${command}"\n\n${USAGE}`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
