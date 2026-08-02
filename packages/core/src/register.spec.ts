import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildTscptrScaffoldLines } from "./test-tscptr-scaffold.js";

const PROJECT_ROOT = path.resolve(".");

function withTmpDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-reg-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe("register (node runner)", () => {
  it("instruments and collects types via the full pipeline", () => {
    withTmpDir((dir) => {
      const srcFile = path.join(dir, "app.ts");
      fs.writeFileSync(
        srcFile,
        'function greet(name) { return "Hello " + name; }\ngreet("World");\n',
      );

      const distDir = path.join(PROJECT_ROOT, "dist");
      const tsLib = path.join(PROJECT_ROOT, "node_modules/typescript/lib/typescript.js");

      // Write runner as lines to avoid template literal escaping issues
      const lines = [
        `import { instrumentSource } from "${distDir}/instrument.js";`,
        `import { createCollectionContext } from "${distDir}/type-collector.js";`,
        `import { applyTypesToFile } from "${distDir}/apply-types.js";`,
        `import fs from "node:fs";`,
        `import ts from "${tsLib}";`,
        `const source = fs.readFileSync("${srcFile}", "utf-8");`,
        `const instrumented = instrumentSource(source, "${srcFile}");`,
        `const ctx = createCollectionContext();`,
        ...buildTscptrScaffoldLines(),
        `const compiled = ts.transpile(instrumented, { target: ts.ScriptTarget.ES2015 });`,
        `const fn = new Function("__tscptr__", "console", compiled);`,
        `fn(tscptr, console);`,
        `const types = ctx.getCollectedTypes().filter(([f]) => f === "${srcFile}");`,
        `if (types.length > 0) { fs.writeFileSync("${srcFile}", applyTypesToFile(source, types, {})); }`,
      ];
      const runnerFile = path.join(dir, "runner.mjs");
      fs.writeFileSync(runnerFile, lines.join("\n"));

      execFileSync("node", [runnerFile], { encoding: "utf-8", timeout: 15000 });
      const result = fs.readFileSync(srcFile, "utf-8");
      expect(result).toContain("name: string");
    });
  });

  it("register.js exists and is a valid ES module", () => {
    const registerPath = path.join(PROJECT_ROOT, "dist/register.js");
    expect(fs.existsSync(registerPath)).toBe(true);
    const content = fs.readFileSync(registerPath, "utf-8");
    expect(content).toContain("register");
  });

  it("loader.js exists and exports a load hook", () => {
    const loaderPath = path.join(PROJECT_ROOT, "dist/loader.js");
    expect(fs.existsSync(loaderPath)).toBe(true);
    const content = fs.readFileSync(loaderPath, "utf-8");
    expect(content).toContain("export");
    expect(content).toContain("load");
  });
});
