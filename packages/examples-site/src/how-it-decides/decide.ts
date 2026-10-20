import type { Cell } from "./cells.js";
import type { DecidedCell } from "./page.js";

import { runPlayground } from "../playground/run.js";

/**
 * Run a cell the way the playground runs a file, and keep what the card shows.
 * The test and the page both go through here, so they cannot run it two ways.
 */
export async function decide(
  cell: Cell,
  libs: ReadonlyMap<string, string>,
): Promise<DecidedCell> {
  const code = cell.code;
  if (code === undefined) return { cell };
  const run = async (applyTo?: string) => {
    const result = await runPlayground(code, libs, {
      applyTo,
      implicitThis: cell.implicitThis,
    });
    if (!result.ok)
      throw new Error(`${cell.kind} · ${cell.outcome}: ${result.error}`);
    return result;
  };
  // Applied twice: the second apply meets what the first one wrote.
  const appliedTo = cell.twice ? (await run()).after : cell.applyTo;
  const result = await run(appliedTo);
  const skip = result.skips.find((s) =>
    cell.name ? s.name === cell.name : s.reason === cell.outcome,
  );
  return {
    cell,
    after: result.after,
    ...(appliedTo !== undefined ? { appliedTo } : {}),
    ...(skip
      ? {
          skip: {
            reason: skip.reason,
            observed: skip.observed,
            detail: skip.detail,
          },
        }
      : {}),
  };
}
