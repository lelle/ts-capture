import type ts from "typescript";

import type { CollectedTypeInfo } from "./collector-contract.js";
import type { InferOptions } from "./configuration.js";
import type { ApplyTelemetry } from "./contract.js";

import { annotateProject } from "./annotate.js";
import { createProjectVerificationContext } from "./apply-types-verify.js";
import { type LocatedSkip, locateSkip } from "./cli/apply-report.js";

export interface InMemoryApplyInput {
  /** The project's files, as paths `system` can read. */
  fileNames: readonly string[];
  types: CollectedTypeInfo;
  compilerOptions: ts.CompilerOptions;
  rootDir: string;
  /**
   * Where the files and TypeScript's own `lib.*.d.ts` are read from. The libs
   * are looked up in the directory of `getExecutingFilePath()`, which
   * `@typescript/vfs`'s `createSystem` leaves unimplemented: set it, e.g. to
   * `"/typescript.js"` for libs at the root.
   */
  system: ts.System;
  infer?: InferOptions;
}

export interface InMemoryApplyResult {
  /** Every observed file's text after apply, changed or not. */
  files: Record<string, string>;
  telemetry: ApplyTelemetry;
  skips: LocatedSkip[];
}

/**
 * What `ts-capture apply` does to a project, for one that is not on disk:
 * the same applier behind the same type-check gate, writing nothing.
 */
export function applyInMemory(input: InMemoryApplyInput): InMemoryApplyResult {
  const { fileNames, compilerOptions, rootDir, system } = input;
  const project = createProjectVerificationContext(fileNames, compilerOptions, rootDir, system);
  const sources = new Map<string, string>();
  const listed = new Set(fileNames);
  const run = annotateProject({
    types: input.types.filter(([file]) => listed.has(file)),
    readFile: (file) => {
      const source = system.readFile(file);
      if (source !== undefined) sources.set(file, source);
      return source;
    },
    oracle: { kind: "project", project },
    infer: input.infer,
  });
  const files: Record<string, string> = {};
  const skips: LocatedSkip[] = [];
  for (const [file, result] of run.files) {
    files[file] = result.text;
    for (const skip of result.skips) skips.push(locateSkip(skip, file, sources.get(file)!));
  }
  return { files, telemetry: run.telemetry, skips };
}
