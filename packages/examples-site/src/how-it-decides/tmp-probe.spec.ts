import { createDefaultMapFromNodeModules } from "@typescript/vfs";
import { writeFileSync } from "node:fs";
import ts from "typescript";
import { it } from "vitest";

import { reachableLibs } from "../playground/libs.js";
import { COMPILER_OPTIONS, runPlayground } from "../playground/run.js";
const libs = reachableLibs(
  createDefaultMapFromNodeModules(COMPILER_OPTIONS, ts),
  ["/lib.es2022.d.ts"],
);
const CASES = (process.env.PROBE ?? "").split("\n---\n");
it("probe", async () => {
  let out = "";
  for (const code of CASES) {
    const r = await runPlayground(code, libs);
    out += r.ok
      ? `=== \n${r.after}\nskips: ${JSON.stringify(r.skips.map((s) => [s.name, s.reason, s.detail, s.observed]))}\n`
      : `ERROR ${r.error}\n`;
  }
  writeFileSync(
    "/private/tmp/claude-501/-Users-sverreolnes-source-ts-capture/c96522ca-fb1f-47a0-a0a1-ddc63b665f89/scratchpad/probe.txt",
    out,
  );
});
