import {
  applyInMemory,
  createObserver,
  INFER_DEFAULTS,
  instrumentSource,
  type LocatedSkip,
  reportLines,
  summaryLines,
} from "@ts-capture/core/browser";
import { createSystem, createVirtualCompilerHost } from "@typescript/vfs";
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
      /** What apply observed and did not write, and why. */
      skips: LocatedSkip[];
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

export interface RunOptions {
  /** Apply to this text instead of `code`: what the code became after the run. */
  applyTo?: string;
  /** Observe `this` where the checker says it is implicitly `any`. */
  implicitThis?: boolean;
  /** Declare a shape written more than once as a named type (`infer.aliasRepeatedShapes`). */
  nameShapes?: boolean;
}

/**
 * Observe `code` running and apply what was seen, the way the CLI would for a
 * one-file project. `libs` holds TypeScript's `lib.*.d.ts` by absolute path.
 */
export async function runPlayground(
  code: string,
  libs: ReadonlyMap<string, string>,
  options: RunOptions = {},
): Promise<PlaygroundResult> {
  const target = options.applyTo ?? code;
  const observer = createObserver();
  try {
    const instrumented = instrumentSource(
      code,
      FILE,
      options.implicitThis
        ? { instrumentImplicitThis: true, program: programOf(code, libs) }
        : undefined,
    );
    const js = ts.transpileModule(instrumented, {
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
      after: target,
      html: String(renderCode(target, target)),
      summary: [NOTHING_OBSERVED],
      report: [],
      skips: [],
    };
  }

  const system: ts.System = {
    ...createSystem(new Map(libs).set(FILE, target)),
    getExecutingFilePath: () => "/typescript.js",
  };
  const { files, telemetry, skips } = applyInMemory({
    fileNames: [FILE],
    infer: {
      ...INFER_DEFAULTS,
      aliasRepeatedShapes: options.nameShapes ?? false,
    },
    types,
    compilerOptions: COMPILER_OPTIONS,
    rootDir: "/",
    system,
  });
  const after = files[FILE] ?? target;
  return {
    ok: true,
    after,
    html: String(renderCode(target, after)),
    summary: summaryLines(telemetry, after === target ? 0 : 1, skips, false),
    report: reportLines(telemetry, skips, () => SHOWN_AS),
    skips,
  };
}

function programOf(
  code: string,
  libs: ReadonlyMap<string, string>,
): ts.Program {
  const system = createSystem(new Map(libs).set(FILE, code));
  const { compilerHost } = createVirtualCompilerHost(
    system,
    COMPILER_OPTIONS,
    ts,
  );
  return ts.createProgram([FILE], COMPILER_OPTIONS, compilerHost);
}
