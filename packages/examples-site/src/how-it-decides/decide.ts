import type { Cell } from "./cells.js";
import type { DecidedCell } from "./page.js";

import { runPlayground } from "../playground/run.js";

/** Run a cell the way the playground runs a file, and keep what the card shows. */
export async function decide(
  cell: Cell,
  libs: ReadonlyMap<string, string>,
): Promise<DecidedCell> {
  if (cell.code === undefined) return { cell };
  const result = await runPlayground(cell.code, libs);
  if (!result.ok)
    throw new Error(`${cell.kind} · ${cell.outcome}: ${result.error}`);
  const skip = result.skips.find((s) => s.name === cell.name);
  return {
    cell,
    after: result.after,
    ...(skip ? { skip: { observed: skip.observed, detail: skip.detail } } : {}),
  };
}
