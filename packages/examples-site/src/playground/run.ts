import {
  applyInMemory,
  type CollectorOptions,
  createObserver,
  INFER_DEFAULTS,
  type InferOptions,
  instrumentSource,
  type LocatedSkip,
  type LocatedWrite,
  reportLines,
  summaryLines,
  typesFromValues,
} from "@ts-capture/core/browser";
import { createSystem, createVirtualCompilerHost } from "@typescript/vfs";
import ts from "typescript";

import type { PlaygroundOptions } from "./options.js";

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
      /** What apply wrote, and by which rule. */
      written: LocatedWrite[];
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
  /** Options over the defaults. */
  infer?: Partial<InferOptions>;
  /** What is observed of each value. */
  literalOptions?: CollectorOptions["literalOptions"];
}

/** The playground's options as apply takes them: the type's, and the observation's. */
export function fromPlaygroundOptions(
  options: Partial<PlaygroundOptions>,
): Required<Pick<RunOptions, "infer" | "literalOptions">> {
  const { "literal.string": literalString = false, ...infer } = options;
  return {
    infer: {
      ...infer,
      literal: { ...INFER_DEFAULTS.literal, string: literalString },
    },
    literalOptions: { literalString },
  };
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
  const observer = createObserver({ literalOptions: options.literalOptions });
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
      html: renderCode(target, target).text,
      summary: [NOTHING_OBSERVED],
      report: [],
      skips: [],
      written: [],
    };
  }

  const system: ts.System = {
    ...createSystem(new Map(libs).set(FILE, target)),
    getExecutingFilePath: () => "/typescript.js",
  };
  const { files, telemetry, skips, written } = applyInMemory({
    fileNames: [FILE],
    infer: { ...INFER_DEFAULTS, ...options.infer },
    types,
    compilerOptions: COMPILER_OPTIONS,
    rootDir: "/",
    system,
  });
  const after = files[FILE] ?? target;
  return {
    ok: true,
    after,
    html: renderCode(target, after).text,
    summary: summaryLines(telemetry, after === target ? 0 : 1, skips, false),
    report: reportLines(telemetry, skips, () => SHOWN_AS),
    skips,
    written,
  };
}

const NOTHING_TO_WRITE =
  "Nothing to write: part of the value is unknown. An empty list seen alone gives apply nothing it would write, and so does an object nested deeper than Depth levels.";

export interface JsonOptions extends Pick<
  RunOptions,
  "infer" | "literalOptions"
> {
  /** What the value is called: the root type's name, and what shapes in it are named after. */
  name?: string;
  maxDepth?: number;
}

const DEFAULT_NAME = "data";

/** The type apply would write for a parameter given the parsed `json`, declared under `name`. */
export function typesFromJson(
  json: string,
  options: JsonOptions = {},
): PlaygroundResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `This is not JSON: ${String(error)}` };
  }
  const typed = (name: string) =>
    typesFromValues([value], {
      name,
      maxDepth: options.maxDepth,
      literalOptions: options.literalOptions,
      infer: options.infer,
    });
  // A name that is no identifier gives no root name; the value is then `data`.
  const named = typed(options.name || DEFAULT_NAME);
  const { rootName, type, declarations } =
    named.rootName === undefined ? typed(DEFAULT_NAME) : named;
  const after =
    type === undefined
      ? ""
      : multiline([`type ${rootName} = ${type};`, ...declarations].join("\n"));
  return {
    ok: true,
    after,
    html: renderCode("", after).text,
    summary: type === undefined ? [NOTHING_TO_WRITE] : [],
    report: [],
    skips: [],
    written: [],
  };
}

/** Type declarations with one member to a line, indented by two. */
function multiline(declarations: string): string {
  const file = ts.createSourceFile(
    "/types.ts",
    declarations,
    ts.ScriptTarget.Latest,
  );
  const unfolded = ts.transform(file, [
    (context) => (root) => {
      const visit = (node: ts.Node): ts.Node =>
        ts.isTypeLiteralNode(node)
          ? ts.factory.createTypeLiteralNode(
              ts.visitNodes(node.members, visit, ts.isTypeElement),
            )
          : ts.visitEachChild(node, visit, context);
      return ts.visitNode(root, visit, ts.isSourceFile);
    },
  ]).transformed[0]!;
  return ts
    .createPrinter()
    .printFile(unfolded)
    .replace(/^(?: {4})+/gm, (indent) => " ".repeat(indent.length / 2));
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
