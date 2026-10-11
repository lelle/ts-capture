import type ts from "typescript";

import type { CollectedTypeInfo } from "./collector-contract.js";

import { applyTypesToFileCst } from "./apply-types-cst.js";
import {
  advanceCurrentSource,
  createProjectVerificationContext,
  createVerificationContext,
  orderByImports,
} from "./apply-types-verify.js";
import { type LocatedSkip, locateSkip } from "./cli/apply-report.js";
import { INFER_DEFAULTS, type InferOptions } from "./configuration.js";
import { type ApplyTelemetry, newApplyTelemetry } from "./contract.js";

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
  const { fileNames, types, compilerOptions, rootDir, system } = input;
  const infer = input.infer ?? INFER_DEFAULTS;
  const grouped = new Map<string, CollectedTypeInfo>();
  for (const entry of types) {
    const entries = grouped.get(entry[0]);
    if (entries) entries.push(entry);
    else grouped.set(entry[0], [entry]);
  }

  const project = createProjectVerificationContext(fileNames, compilerOptions, rootDir, system);
  const telemetry = newApplyTelemetry();
  const skips: LocatedSkip[] = [];
  const files: Record<string, string> = {};
  const observed = [...grouped.keys()].filter((file) => fileNames.includes(file));
  const ordered = orderByImports(
    observed,
    project.reverseImportGraph,
    system.useCaseSensitiveFileNames,
  );

  for (const file of ordered) {
    const source = system.readFile(file);
    if (source === undefined) continue;
    const verify = createVerificationContext(project, file, source);
    const firstSkipOfFile = telemetry.skipped.length;
    const result = applyTypesToFileCst(
      source,
      grouped.get(file)!,
      { infer, filename: file, verify, telemetry },
      project.service.getProgram(),
    );
    advanceCurrentSource(verify, result);
    for (const skip of telemetry.skipped.slice(firstSkipOfFile)) {
      skips.push(locateSkip(skip, file, source));
    }
    files[file] = result;
  }
  return { files, telemetry, skips };
}
