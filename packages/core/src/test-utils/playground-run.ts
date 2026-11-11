import path from "node:path";
import ts from "typescript";

import type { CollectorOptions } from "../collector-contract.js";

import { annotate } from "../annotate.js";
import {
  applyInMemory,
  createObserver,
  INFER_DEFAULTS,
  type InferOptions,
  instrumentSource,
} from "../browser.js";
import { locateSite } from "../cli/apply-report.js";

// Observe a source running and apply what was seen, the way the playground
// does, so a spec using it and the playground cannot disagree.

const FILE = "/playground.ts";
const libDir = path.dirname(ts.getDefaultLibFilePath({}));

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  noEmit: true,
};

function memorySystem(source: string): ts.System {
  const read = (file: string): string | undefined =>
    file === FILE
      ? source
      : file.startsWith("/ts/")
        ? ts.sys.readFile(path.join(libDir, file.slice(4)))
        : undefined;
  return {
    ...ts.sys,
    useCaseSensitiveFileNames: true,
    getExecutingFilePath: () => "/ts/typescript.js",
    getCurrentDirectory: () => "/",
    readFile: read,
    fileExists: (file) => read(file) !== undefined,
    directoryExists: (dir) => dir === "/" || dir === "/ts",
    getDirectories: () => [],
    readDirectory: () => [],
  };
}

export interface RunOptions {
  project?: boolean;
  implicitThis?: boolean;
  infer?: Partial<InferOptions>;
  /** What the run observes of each value. */
  collector?: CollectorOptions;
}

export interface Decided {
  line: number;
  name: string;
  outcome: string;
  rule: string;
  type: string;
  detail?: string;
}

function programOf(source: string): ts.Program {
  const system = memorySystem(source);
  const host = ts.createCompilerHost(compilerOptions);
  host.readFile = system.readFile;
  host.fileExists = system.fileExists;
  host.getCurrentDirectory = () => "/";
  host.getDefaultLibLocation = () => "/ts";
  host.getSourceFile = (name, language) => {
    const text = system.readFile(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, language);
  };
  return ts.createProgram([FILE], compilerOptions, host);
}

/** Observe `source` running, and apply what was seen to `target`. */
export async function run(
  source: string,
  target = source,
  { project = true, implicitThis = false, infer = {}, collector }: RunOptions = {},
): Promise<{ after: string; decided: Decided[] }> {
  const observer = createObserver(collector);
  const instrumented = instrumentSource(
    source,
    FILE,
    implicitThis ? { instrumentImplicitThis: true, program: programOf(source) } : undefined,
  );
  const js = ts.transpileModule(instrumented, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  new Function("__tscptr__", js)(observer.hook);
  const types = await observer.collect();
  const result = project
    ? applyInMemory({
        fileNames: [FILE],
        types,
        compilerOptions,
        rootDir: "/",
        system: memorySystem(target),
        infer: { ...INFER_DEFAULTS, ...infer },
      })
    : located(target, annotate(target, types, { filename: FILE, infer }));
  const decided: Decided[] = [
    ...result.written.map((w) => ({ ...w, outcome: "written" })),
    ...result.skips.map((s) => ({ ...s, outcome: s.reason, rule: s.rule ?? "", type: s.observed })),
  ].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return { after: result.files[FILE] ?? target, decided };
}

function located(source: string, result: ReturnType<typeof annotate>) {
  return {
    files: { [FILE]: result.text },
    skips: result.skips.map((skip) => locateSite(skip, FILE, source)),
    written: (result.telemetry.written ?? []).map((write) => locateSite(write, FILE, source)),
  };
}
