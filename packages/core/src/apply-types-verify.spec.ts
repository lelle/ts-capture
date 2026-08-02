import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  commitReplacements,
  createProjectVerificationContext,
  createVerificationContext,
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
});
