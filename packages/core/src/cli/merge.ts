import fs from "node:fs";
import path from "node:path";

import type { CollectedTypeInfo } from "../type-collector.js";

// Per-process dump filename pattern emitted by the runtime + vite-plugin
// collector snippets: `ts-capture-types-<uuid>.json`. The merge subcommand
// uses this to filter when given a directory. The legacy
// `ts-capture-types-<pid>.json` pattern is also accepted so older dumps
// still merge cleanly during the transition; the regex matches both.
const DUMP_FILE_RE = /^ts-capture-types-[0-9a-f-]+\.json$/i;

/**
 * `ts-capture merge <dir-or-files...> [--out <path>]` — merge per-PID
 * type-dump files into a single types.json. Vitest's default forks pool
 * produces one dump per spec file; without merging them the apply step only
 * sees observations from one fork and silently misses the rest.
 */
export function cmdMerge(args: string[]) {
  // Walk args manually so we can pull out --out's value AND skip both the
  // flag and its value when building the positional list. (A naive
  // `args.filter(a => !a.startsWith("-"))` would treat the --out path as
  // an extra positional input.)
  const positional: string[] = [];
  let outPath: string | undefined;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "merge") {
      i++;
      continue;
    }
    if (a === "--out" || a === "-o") {
      outPath = args[i + 1];
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      // Unknown flag — skip silently for forward-compat; surfacing every
      // unknown flag as an error tends to break user workflows when a
      // newer CLI introduces flags that older callers don't know.
      i++;
      continue;
    }
    positional.push(a);
    i++;
  }

  if (positional.length === 0) {
    process.stderr.write("Error: missing input — pass a directory or one or more dump files\n");
    process.exit(1);
  }

  // Resolve positional args to a flat list of dump file paths.
  const dumpFiles: string[] = [];
  for (const input of positional) {
    if (!fs.existsSync(input)) {
      process.stderr.write(`Error: path not found: ${input}\n`);
      process.exit(1);
    }
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      const matched = fs
        .readdirSync(input)
        .filter((name) => DUMP_FILE_RE.test(name))
        .map((name) => path.join(input, name));
      dumpFiles.push(...matched);
    } else {
      dumpFiles.push(path.resolve(input));
    }
  }

  if (dumpFiles.length === 0) {
    process.stderr.write(
      "Error: no ts-capture-types-*.json files found. Vitest's runtime+vite collectors emit them under TS_CAPTURE_TYPES_DIR (default: os.tmpdir()).\n",
    );
    process.exit(1);
  }

  // Streaming merge: read-and-emit one file at a time instead of
  // accumulating every entry into a single in-memory array. Peak
  // memory drops from O(total dump size × 2) (parsed + stringified)
  // to O(largest single dump's parsed content + small per-entry
  // stringification).
  //
  // The output format is a single JSON array of CollectedTypeEntry
  // tuples. We emit `[`, then each entry inline as
  // `JSON.stringify(entry)` separated by commas, then `]`.
  // Synchronous I/O preserved so failure modes match the old code.
  const useFile = outPath !== undefined;
  const resolvedOutPath = useFile ? path.resolve(outPath!) : "";
  const fileHandle = useFile ? fs.openSync(resolvedOutPath, "w") : -1;
  const write = (s: string): void => {
    if (useFile) fs.writeSync(fileHandle, s);
    else process.stdout.write(s);
  };

  write("[");
  let needComma = false;
  let count = 0;
  for (const file of dumpFiles) {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as CollectedTypeInfo;
    for (const entry of content) {
      if (needComma) write(",");
      write(JSON.stringify(entry));
      needComma = true;
      count++;
    }
  }
  write("]");

  if (useFile) {
    fs.closeSync(fileHandle);
    process.stdout.write(
      `merge: ${dumpFiles.length} dump(s) → ${count} entries → ${resolvedOutPath}\n`,
    );
  }
}
