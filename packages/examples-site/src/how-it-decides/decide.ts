import { runPlayground } from "../playground/run.js";
import { type CorpusExample, type Outcome, type SiteKind } from "./corpus.js";
import { siteKind } from "./site-kind.js";

/** An example, run: what apply wrote, and what it decided at the site. */
export interface DecidedExample {
  example: CorpusExample;
  kind: SiteKind;
  after: string;
  /** The text the last apply was given, when it was not the code that ran. */
  appliedTo?: string;
  atSite?: {
    outcome: Outcome;
    rule: string;
    observed?: string;
    detail?: string;
  };
}

// The same line core's corpus spec adds: the code moved after the run.
const MOVED = "// A line added after the run moves everything below it.\n";

/**
 * Run an example the way the playground runs a file. The test and the page
 * both go through here, so they cannot run it two ways.
 */
export async function decide(
  example: CorpusExample,
  libs: ReadonlyMap<string, string>,
): Promise<DecidedExample> {
  const id = `${example.rule}/${example.name}`;
  if (example.apply === "no-project") {
    throw new Error(`${id}: the playground always has a project`);
  }
  const run = async (applyTo?: string) => {
    const result = await runPlayground(example.code, libs, {
      applyTo,
      implicitThis: example.apply === "implicit-this",
      infer: example.infer,
    });
    if (!result.ok) throw new Error(`${id}: ${result.error}`);
    return result;
  };
  const appliedTo =
    example.apply === "twice"
      ? (await run()).after
      : example.apply === "moved"
        ? MOVED + example.code
        : undefined;
  const result = await run(appliedTo);
  // Moved code's positions no longer point at the site they were recorded for.
  const at = ({ name }: { name: string }) =>
    example.apply === "moved" || name === example.site;
  const records = [
    ...result.skips.filter(at).map((skip) => ({
      line: skip.line,
      atSite: {
        outcome: skip.reason,
        rule: skip.rule ?? "",
        observed: skip.observed,
        detail: skip.detail,
      },
    })),
    ...result.written.filter(at).map((write) => ({
      line: write.line,
      atSite: {
        outcome: "written" as const,
        rule: write.rule,
        observed: write.type,
      },
    })),
  ];
  const found =
    records.find((record) => record.atSite.rule === example.rule) ?? records[0];
  // Positions are in the text the last apply was given.
  return {
    example,
    kind: siteKind(appliedTo ?? example.code, example.site, found?.line),
    after: result.after,
    ...(appliedTo !== undefined ? { appliedTo } : {}),
    ...(found ? { atSite: found.atSite } : {}),
  };
}
