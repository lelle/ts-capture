import ts from "typescript";

import type { InstrumentOptions } from "./transformer.js";

import { getProgram } from "./compiler-helper.js";
import { transformSourceFile } from "./transformer.js";

export function instrumentSource(
  source: string,
  fileName: string,
  options?: InstrumentOptions,
): string {
  const opts: InstrumentOptions = {
    instrumentCallExpressions: false,
    instrumentImplicitThis: false,
    skipTscptrDeclarations: false,
    ...options,
  };

  const program = getProgram(opts);
  const sourceFile = program
    ? program.getSourceFile(fileName)
    : ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  if (!sourceFile) {
    throw new Error(
      `File not found in program: ${fileName}. ` +
        `Ensure the file is included in your tsconfig.json.`,
    );
  }

  const transformed = transformSourceFile(sourceFile, opts, program);
  return ts.createPrinter().printFile(transformed);
}
