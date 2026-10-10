import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterAll } from "vitest";

// A throwaway TypeScript project on disk, for specs that need a Program or a
// verify context. On disk rather than in memory because module resolution
// goes through `ts.sys.fileExists`, and an import between two in-memory files
// would never resolve. One root per spec file, removed when the file is done.

const TEST_COMPILER_OPTIONS = {
  strict: true,
  target: "ES2022",
  module: "ES2022",
  moduleResolution: "Bundler",
  jsx: "preserve",
  skipLibCheck: true,
  noEmit: true,
} as const;

export interface TestProject {
  dir: string;
  fileNames: string[];
  compilerOptions: ts.CompilerOptions;
  /** The absolute path of a file given by the name it was created under. */
  pathOf(name: string): string;
  read(name: string): string;
  write(name: string, content: string): void;
}

let root: string | undefined;

function tmpRoot(): string {
  if (root) return root;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-spec-"));
  return root;
}

afterAll(() => {
  if (!root) return;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  root = undefined;
});

/**
 * Write `files` under a fresh directory with a strict tsconfig and return the
 * parsed project. File names are relative to the directory.
 */
export function makeProject(files: Record<string, string>): TestProject {
  const dir = fs.mkdtempSync(path.join(tmpRoot(), "p-"));
  const tsconfig = { compilerOptions: TEST_COMPILER_OPTIONS, include: ["**/*.ts", "**/*.tsx"] };
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, dir);
  return {
    dir,
    fileNames: parsed.fileNames,
    compilerOptions: parsed.options,
    pathOf: (name) => path.join(dir, name),
    read: (name) => fs.readFileSync(path.join(dir, name), "utf-8"),
    write: (name, content) => fs.writeFileSync(path.join(dir, name), content),
  };
}

/**
 * Declaration files parsed once per process. `ts.createProgram` parses every
 * lib file again for each Program it builds, and that is most of the cost of
 * one; the project's own files are read fresh each time.
 */
const declarationFiles = new Map<string, ts.SourceFile>();

function cachingHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options, /*setParentNodes*/ true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    if (!fileName.endsWith(".d.ts")) {
      return getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    }
    const cached = declarationFiles.get(fileName);
    if (cached) return cached;
    const parsed = getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    if (parsed) declarationFiles.set(fileName, parsed);
    return parsed;
  };
  return host;
}

/** A Program over the project's files as they are on disk now. */
export function programOf(project: TestProject): ts.Program {
  return ts.createProgram(
    project.fileNames,
    project.compilerOptions,
    cachingHost(project.compilerOptions),
  );
}
