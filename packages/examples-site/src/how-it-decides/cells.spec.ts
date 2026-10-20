import { createDefaultMapFromNodeModules } from "@typescript/vfs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { reachableLibs } from "../playground/libs.js";
import { COMPILER_OPTIONS, runPlayground } from "../playground/run.js";
import { CELLS } from "./cells.js";

const libs = reachableLibs(
  createDefaultMapFromNodeModules(COMPILER_OPTIONS, ts),
  ["/lib.es2022.d.ts"],
);
const coreSrc = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../core/src",
);
const examples = JSON.parse(
  readFileSync(
    resolve(coreSrc, "../../../docs/examples/examples.json"),
    "utf-8",
  ),
) as { examples: { id: string }[] };

const runnable = CELLS.filter((cell) => cell.code !== undefined);

describe("how it decides: each cell is what the applier does", () => {
  it.each(
    runnable.map((cell) => [`${cell.kind} · ${cell.outcome}`, cell] as const),
  )("%s", async (_, cell) => {
    const result = await runPlayground(cell.code!, libs);
    if (!result.ok) throw new Error(result.error);
    const skip = result.skips.find((s) => s.name === cell.name);
    // A parameter is written as `name: T`, a return as `): T`.
    const writtenAt =
      cell.kind === "return" ? /\): / : new RegExp(`\\b${cell.name}: `);
    if (cell.outcome === "written") {
      expect(skip).toBeUndefined();
      expect(result.after).not.toBe(cell.code);
      expect(result.after).toMatch(writtenAt);
    } else {
      expect(skip?.reason).toBe(cell.outcome);
      expect(result.after).not.toMatch(writtenAt);
    }
  });

  it.each(
    CELLS.map((cell) => [`${cell.kind} · ${cell.outcome}`, cell] as const),
  )("%s names a function that decides it", (_, cell) => {
    const source = readFileSync(resolve(coreSrc, cell.decidedBy.file), "utf-8");
    expect(source).toMatch(new RegExp(`function ${cell.decidedBy.symbol}\\b`));
  });

  it("says why a cell has no code", () => {
    for (const cell of CELLS)
      expect(cell.code ?? cell.unreachable).toBeTruthy();
  });

  it("places only real examples that exist", () => {
    const ids = new Set(examples.examples.map((example) => example.id));
    for (const cell of CELLS)
      for (const id of cell.real ?? []) expect(ids).toContain(id);
  });
});
