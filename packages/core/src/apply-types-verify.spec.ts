import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  advanceCurrentSource,
  commitReplacements,
  createProjectVerificationContext,
  createVerificationContext,
  filterAcceptedReplacements,
  orderByImports,
  wouldIntroduceErrors,
} from "./apply-types-verify.js";

/**
 * Tests for the verification helper. Each test sets up a
 * tiny in-temp-dir project (one or two .ts files) and asks the
 * helper whether a candidate annotation would type-check.
 *
 * Self-contained: temp dirs are created per test and cleaned up
 * after. No shared state between tests.
 */
describe("apply-types-verify", () => {
  // tmpdir created in beforeAll, cleaned up in afterAll — kept
  // session-scoped so the LanguageService's document registry can
  // reuse parsed lib.d.ts across tests.
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-verify-"));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  function makeProject(files: Record<string, string>): {
    dir: string;
    target: string;
    fileNames: string[];
    compilerOptions: ts.CompilerOptions;
  } {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "p-"));
    const tsconfig = {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "Bundler",
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["**/*.ts"],
    };
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, dir);
    const fileNames = parsed.fileNames;
    const targetFile = fileNames.find((f) => f.endsWith("target.ts"));
    if (!targetFile) {
      throw new Error("test must include a `target.ts` file");
    }
    return { dir, target: targetFile, fileNames, compilerOptions: parsed.options };
  }

  it("accepts a syntactically correct annotation that doesn't conflict", () => {
    const proj = makeProject({
      "target.ts": "const x = 1;\n",
    });
    const sourceText = fs.readFileSync(proj.target, "utf-8");
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const ctx = createVerificationContext(projectCtx, proj.target, sourceText);
    // Insert `: number` at the end of `x`.
    const declEnd = sourceText.indexOf("x") + 1;
    const probe = [{ start: declEnd, end: declEnd, text: ": number" }];
    expect(wouldIntroduceErrors(ctx, probe)).toBe(false);
  });

  it("rejects an annotation that narrows below the actual value type", () => {
    // `const x = 1` cannot be annotated `: string` — TS rejects it.
    const proj = makeProject({
      "target.ts": "const x = 1;\n",
    });
    const sourceText = fs.readFileSync(proj.target, "utf-8");
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const ctx = createVerificationContext(projectCtx, proj.target, sourceText);
    const declEnd = sourceText.indexOf("x") + 1;
    const probe = [{ start: declEnd, end: declEnd, text: ": string" }];
    expect(wouldIntroduceErrors(ctx, probe)).toBe(true);
  });

  it("rejects a returnType that excludes the undefined branch", () => {
    // Direct analog to the returnType-narrowing case from the react-admin eval:
    // function returns `T | undefined` along one branch; an
    // annotation that excludes undefined breaks it.
    const proj = makeProject({
      "target.ts": [
        "export function maybe(x: number) {",
        "    if (x < 0) return undefined;",
        "    return { value: x * 2 };",
        "}",
        "",
      ].join("\n"),
    });
    const sourceText = fs.readFileSync(proj.target, "utf-8");
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const ctx = createVerificationContext(projectCtx, proj.target, sourceText);
    // Insert `: { value: number }` after the `)` of `(x: number)`.
    const paramsClose = sourceText.indexOf(")") + 1;
    const probe = [{ start: paramsClose, end: paramsClose, text: ": { value: number }" }];
    expect(wouldIntroduceErrors(ctx, probe)).toBe(true);
  });

  it("does not mutate context on a rejected probe", () => {
    const proj = makeProject({
      "target.ts": "const x = 1;\n",
    });
    const sourceText = fs.readFileSync(proj.target, "utf-8");
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const ctx = createVerificationContext(projectCtx, proj.target, sourceText);
    const declEnd = sourceText.indexOf("x") + 1;
    // First probe: bad annotation → rejected.
    wouldIntroduceErrors(ctx, [{ start: declEnd, end: declEnd, text: ": string" }]);
    // Second probe: good annotation → must still pass (i.e. context
    // wasn't poisoned by the first probe).
    expect(wouldIntroduceErrors(ctx, [{ start: declEnd, end: declEnd, text: ": number" }])).toBe(
      false,
    );
  });

  it("commit advances the in-memory source seen by future probes", () => {
    // commitReplacements applies + re-baselines so apply's accepted
    // diff is persistent for slice-2 wiring. Slice 1's API is
    // intentionally simple: positions are always given in terms of
    // the CURRENT source (post-commit). Subsequent probes referring
    // to original-source positions would need to re-translate.
    const proj = makeProject({
      "target.ts": "const a = 1;\n",
    });
    const sourceText = fs.readFileSync(proj.target, "utf-8");
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const ctx = createVerificationContext(projectCtx, proj.target, sourceText);
    const aEnd = sourceText.indexOf("a") + 1;
    commitReplacements(ctx, [{ start: aEnd, end: aEnd, text: ": number" }]);
    expect(ctx.currentSource).toContain("const a: number = 1");
  });

  it("catches diagnostics surfacing through a re-export barrel", () => {
    // The shape that motivates the transitive scan: target.ts exports a value used
    // by consumer.ts, but consumer.ts imports via `index.ts` —
    // a barrel file that does `export * from './target'`. With the
    // earlier direct-importer scan, `findDirectImporters(target)`
    // only finds `index.ts`. The consumer's type error (from a
    // bad annotation in target.ts) goes unnoticed.
    //
    // Setup: target exports a function whose inferred return type
    // is `string`. Probe replaces the return body so the inferred
    // type becomes `number` — clean inside target (a function
    // returning a literal number type-checks), but consumer.ts
    // assigns the result to `string` and fails.
    const proj = makeProject({
      "target.ts": "export function greet() { return 'hello'; }\n",
      "index.ts": "export * from './target';\n",
      "consumer.ts": "import { greet } from './index';\nconst out: string = greet();\n",
    });
    const sourceText = fs.readFileSync(proj.target, "utf-8");
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    // Transitive importer set must include consumer.ts (2 hops away).
    const ctx = createVerificationContext(projectCtx, proj.target, sourceText);
    const consumer = proj.fileNames.find((f) => f.endsWith("consumer.ts"));
    expect(ctx.importersOfTarget).toContain(consumer);

    // Probe: change `'hello'` to `42`. Target stays clean (function
    // returning a literal type-checks); consumer's `string = number`
    // assignment fails. Direct-importer scan would have missed this;
    // transitive scan catches it.
    const helloStart = sourceText.indexOf("'hello'");
    const probe = [{ start: helloStart, end: helloStart + "'hello'".length, text: "42" }];
    expect(wouldIntroduceErrors(ctx, probe)).toBe(true);
  });

  it("accepts an annotation when an untyped site remains later in the file", () => {
    const proj = makeProject({
      "target.ts": [
        "export function one(a) {",
        "    return a;",
        "}",
        "",
        "export function two(b) {",
        "    return b;",
        "}",
        "",
      ].join("\n"),
    });
    const sourceText = fs.readFileSync(proj.target, "utf-8");
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const ctx = createVerificationContext(projectCtx, proj.target, sourceText);
    const paramEnd = sourceText.indexOf("one(a)") + "one(a".length;
    const probe = [{ start: paramEnd, end: paramEnd, text: ": number" }];
    expect(wouldIntroduceErrors(ctx, probe)).toBe(false);
  });

  it("graph is built once on project context, not per-target", () => {
    // Two target files in the same project — both should pull from
    // the same `reverseImportGraph` object on the project context,
    // not rebuild it. This is the cost reduction we trade for the
    // wider transitive scan.
    const proj = makeProject({
      "target.ts": "export const a = 1;\n",
      "other.ts": "export const b = 2;\n",
      "consumer.ts":
        "import { a } from './target';\nimport { b } from './other';\nconsole.log(a + b);\n",
    });
    const projectCtx = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    expect(projectCtx.reverseImportGraph.size).toBeGreaterThan(0);
    const other = proj.fileNames.find((f) => f.endsWith("other.ts"));
    if (!other) throw new Error("test setup error");
    const otherSource = fs.readFileSync(other, "utf-8");
    const ctx1 = createVerificationContext(
      projectCtx,
      proj.target,
      fs.readFileSync(proj.target, "utf-8"),
    );
    const ctx2 = createVerificationContext(projectCtx, other, otherSource);
    // Both contexts share the same graph (identity comparison) — no
    // rebuild between them.
    expect(ctx1.project.reverseImportGraph).toBe(ctx2.project.reverseImportGraph);
  });

  // A file's own diagnostics move with its text. A second pass over a file
  // the first pass has edited must not take the ones that moved for new.
  it("keeps a diagnostic the file already had when the text before it moves", () => {
    const src = 'export const n: number = "x";\n';
    const proj = makeProject({ "target.ts": src });
    const project = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const ctx = createVerificationContext(project, proj.target, src);
    advanceCurrentSource(ctx, "type T = { a: number };\n\n" + src);
    expect(wouldIntroduceErrors(ctx, [{ start: 0, end: 0, text: "export const m = 1;\n" }])).toBe(
      false,
    );
  });

  // An annotation that names a type apply is about to declare only
  // type-checks with the declaration beside it, and the declaration alone is
  // an unused local wherever `noUnusedLocals` is on. So each probe carries the
  // declarations its candidates refer to, and no others.
  it("probes each candidate subset with the declarations it refers to", () => {
    const src = "function a(p) { return p.x; }\nfunction b(q) { return q.y; }\n";
    const proj = makeProject({ "target.ts": src });
    const project = createProjectVerificationContext(
      proj.fileNames,
      { ...proj.compilerOptions, noUnusedLocals: true },
      proj.dir,
    );
    const ctx = createVerificationContext(project, proj.target, src);
    const declaration = { start: 0, end: 0, text: "type P = { x: number };\n" };
    const supporting = (subset: ReadonlyArray<{ text: string }>) =>
      subset.some((c) => /\bP\b/.test(c.text)) ? [declaration] : [];
    const pos = (needle: string) => src.indexOf(needle) + needle.length;
    const candidates = [
      { start: pos("a(p"), end: pos("a(p"), text: ": P" },
      { start: pos("b(q"), end: pos("b(q"), text: ": { y: boolean }" },
      { start: pos("b(q"), end: pos("b(q"), text: ": { z: boolean }" },
    ];
    expect(filterAcceptedReplacements(ctx, candidates, supporting)).toEqual([0, 1]);
  });
});

describe("orderByImports", () => {
  it("puts a file after the files it imports, keeps ties and cycles in the given order", () => {
    const importersOf = new Map([
      ["/p/pricing.ts", new Set(["/p/orders.ts"])],
      ["/p/a.ts", new Set(["/p/b.ts"])],
      ["/p/b.ts", new Set(["/p/a.ts"])],
      ["/p/elsewhere.ts", new Set(["/p/other.ts"])],
    ]);
    const files = ["/p/orders.ts", "/p/other.ts", "/p/pricing.ts", "/p/a.ts", "/p/b.ts"];
    expect(orderByImports(files, importersOf)).toEqual([
      "/p/other.ts",
      "/p/pricing.ts",
      "/p/orders.ts",
      "/p/a.ts",
      "/p/b.ts",
    ]);
  });
});

describe("apply-types-verify with a system that is not the disk", () => {
  const libDir = path.dirname(ts.getDefaultLibFilePath({}));
  const memorySystem = (files: Record<string, string>): ts.System => {
    const read = (file: string): string | undefined =>
      file.startsWith("/ts/") ? ts.sys.readFile(path.join(libDir, file.slice(4))) : files[file];
    return {
      ...ts.sys,
      useCaseSensitiveFileNames: true,
      getExecutingFilePath: () => "/ts/typescript.js",
      getCurrentDirectory: () => "/app",
      readFile: read,
      fileExists: (file) => read(file) !== undefined,
      directoryExists: (dir) => dir === "/app" || dir === "/ts",
      getDirectories: () => [],
      readDirectory: () => [],
    };
  };
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };

  it("checks a file that exists only in the system it was given", () => {
    const source = "const x = 1;\n";
    const system = memorySystem({ "/app/demo.ts": source });
    const project = createProjectVerificationContext(["/app/demo.ts"], options, "/app", system);
    const ctx = createVerificationContext(project, "/app/demo.ts", source);
    const at = source.indexOf("x") + 1;
    expect(wouldIntroduceErrors(ctx, [{ start: at, end: at, text: ": number" }])).toBe(false);
    expect(wouldIntroduceErrors(ctx, [{ start: at, end: at, text: ": string" }])).toBe(true);
  });

  it("follows imports through that system", () => {
    const source = "export function double(n) {\n  return n * 2;\n}\n";
    const system = memorySystem({
      "/app/caller.ts": 'import { double } from "./demo";\ndouble(2);\n',
      "/app/demo.ts": source,
    });
    const project = createProjectVerificationContext(
      ["/app/demo.ts", "/app/caller.ts"],
      { ...options, strict: false },
      "/app",
      system,
    );
    const ctx = createVerificationContext(project, "/app/demo.ts", source);
    expect(ctx.importersOfTarget).toEqual(["/app/caller.ts"]);
    const at = source.indexOf("n") + 1;
    expect(wouldIntroduceErrors(ctx, [{ start: at, end: at, text: ": string" }])).toBe(true);
  });
});
