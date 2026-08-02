import fs from "node:fs";
import path from "node:path";

import { instrumentSource } from "../instrument.js";

/** `ts-capture instrument <file> [--in-place]` — instrument a file with type tracking. */
export function cmdInstrument(args: string[], flags: Set<string>) {
  const filePath = args.find((a) => !a.startsWith("-") && a !== "instrument");
  if (!filePath) {
    process.stderr.write("Error: missing file argument\n");
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  const source = fs.readFileSync(resolved, "utf-8");
  const result = instrumentSource(source, resolved);

  if (flags.has("--in-place")) {
    fs.writeFileSync(resolved, result);
  } else {
    process.stdout.write(result);
  }
}
