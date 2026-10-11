import {
  applyInMemory,
  createObserver,
  instrumentSource,
  reportLines,
  summaryLines,
} from "@ts-capture/core/browser";
import { createSystem } from "@typescript/vfs";
import ts from "typescript";

import { renderCode } from "../code.js";

export type PlaygroundResult =
  | { ok: false; error: string }
  | {
      ok: true;
      after: string;
      /** `after`, highlighted, with what apply added wrapped in `ins`. */
      html: string;
      summary: string[];
      report: string[];
    };

export const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  noEmit: true,
};

const FILE = "/playground.ts";
const SHOWN_AS = "playground.ts";
const NOTHING_OBSERVED =
  "Nothing was observed. Call your functions at the end of the file: the calls are what ts-capture learns from.";

/**
 * Observe `code` running and apply what was seen, the way the CLI would for a
 * one-file project. `libs` holds TypeScript's `lib.*.d.ts` by absolute path.
 */
export async function runPlayground(
  code: string,
  libs: ReadonlyMap<string, string>,
): Promise<PlaygroundResult> {
  const observer = createObserver();
  try {
    const js = ts.transpileModule(instrumentSource(code, FILE), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    }).outputText;
    // Running the visitor's own code is what the page is for; it runs in a worker.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("__tscptr__", "exports", js)(observer.hook, {});
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  const types = await observer.collect();
  if (types.length === 0) {
    return {
      ok: true,
      after: code,
      html: renderCode(code, code),
      summary: [NOTHING_OBSERVED],
      report: [],
    };
  }

  const system: ts.System = {
    ...createSystem(new Map(libs).set(FILE, code)),
    getExecutingFilePath: () => "/typescript.js",
  };
  const { files, telemetry, skips } = applyInMemory({
    fileNames: [FILE],
    types,
    compilerOptions: COMPILER_OPTIONS,
    rootDir: "/",
    system,
  });
  const after = files[FILE] ?? code;
  return {
    ok: true,
    after,
    html: renderCode(code, after),
    summary: summaryLines(telemetry, after === code ? 0 : 1, skips, false),
    report: reportLines(telemetry, skips, () => SHOWN_AS),
  };
}
