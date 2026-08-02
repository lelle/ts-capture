import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildTscptrScaffoldLines } from "./test-tscptr-scaffold.js";

const CLI = path.resolve("dist/cli.js");
const DIST = path.resolve("dist");
const NODE_MODULES = path.resolve("node_modules");
const TS_LIB = path.join(NODE_MODULES, "typescript/lib/typescript.js");

function withTmpDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-e2e-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe("E2E: CLI pipeline (instrument → run → apply)", () => {
  it("adds string type via full CLI flow", () => {
    withTmpDir((dir) => {
      const srcFile = path.join(dir, "app.ts");
      fs.writeFileSync(
        srcFile,
        ['function greet(name) { return "Hello " + name; }', 'greet("World");', ""].join("\n"),
      );

      // Step 1: instrument via CLI
      const instrumented = execFileSync("node", [CLI, "instrument", srcFile], {
        encoding: "utf-8",
      });

      // Step 2: write a runner that transpiles + executes + collects + dumps JSON
      const runnerFile = path.join(dir, "runner.mjs");
      const typesFile = path.join(dir, "types.json");
      fs.writeFileSync(
        runnerFile,
        [
          `import { createCollectionContext } from "${DIST}/type-collector.js";`,
          `import fs from "node:fs";`,
          `import ts from "${TS_LIB}";`,
          `const ctx = createCollectionContext();`,
          ...buildTscptrScaffoldLines(),
          `const src = fs.readFileSync("${path.join(dir, "instrumented.ts")}", "utf-8");`,
          `const compiled = ts.transpile(src, {target: ts.ScriptTarget.ES2015});`,
          `new Function("__tscptr__","console",compiled)(tscptr,console);`,
          `fs.writeFileSync("${typesFile}", JSON.stringify(ctx.getCollectedTypes()));`,
        ].join("\n"),
      );
      fs.writeFileSync(path.join(dir, "instrumented.ts"), instrumented);

      execFileSync("node", [runnerFile], { encoding: "utf-8", timeout: 15000 });

      // Step 3: apply via CLI
      execFileSync("node", [CLI, "apply", typesFile], { encoding: "utf-8" });

      // Verify
      const result = fs.readFileSync(srcFile, "utf-8");
      expect(result).toContain("name: string");
    });
  });

  it("adds number type to arrow function via CLI flow", () => {
    withTmpDir((dir) => {
      const srcFile = path.join(dir, "math.ts");
      fs.writeFileSync(srcFile, "const double = (x) => x * 2;\ndouble(21);\n");

      const instrumented = execFileSync("node", [CLI, "instrument", srcFile], {
        encoding: "utf-8",
      });

      const runnerFile = path.join(dir, "runner.mjs");
      const typesFile = path.join(dir, "types.json");
      fs.writeFileSync(
        runnerFile,
        [
          `import { createCollectionContext } from "${DIST}/type-collector.js";`,
          `import fs from "node:fs";`,
          `import ts from "${TS_LIB}";`,
          `const ctx = createCollectionContext();`,
          ...buildTscptrScaffoldLines(),
          `const src = fs.readFileSync("${path.join(dir, "instrumented.ts")}", "utf-8");`,
          `const compiled = ts.transpile(src, {target: ts.ScriptTarget.ES2015});`,
          `new Function("__tscptr__","console",compiled)(tscptr,console);`,
          `fs.writeFileSync("${typesFile}", JSON.stringify(ctx.getCollectedTypes()));`,
        ].join("\n"),
      );
      fs.writeFileSync(path.join(dir, "instrumented.ts"), instrumented);

      execFileSync("node", [runnerFile], { encoding: "utf-8", timeout: 15000 });
      execFileSync("node", [CLI, "apply", typesFile], { encoding: "utf-8" });

      const result = fs.readFileSync(srcFile, "utf-8");
      expect(result).toContain("x: number");
    });
  });

  it("handles union types from multiple calls", () => {
    withTmpDir((dir) => {
      const srcFile = path.join(dir, "union.ts");
      fs.writeFileSync(
        srcFile,
        ["function show(val) { return String(val); }", 'show("hello");', "show(42);", ""].join(
          "\n",
        ),
      );

      const instrumented = execFileSync("node", [CLI, "instrument", srcFile], {
        encoding: "utf-8",
      });

      const runnerFile = path.join(dir, "runner.mjs");
      const typesFile = path.join(dir, "types.json");
      fs.writeFileSync(
        runnerFile,
        [
          `import { createCollectionContext } from "${DIST}/type-collector.js";`,
          `import fs from "node:fs";`,
          `import ts from "${TS_LIB}";`,
          `const ctx = createCollectionContext();`,
          ...buildTscptrScaffoldLines(),
          `const src = fs.readFileSync("${path.join(dir, "instrumented.ts")}", "utf-8");`,
          `const compiled = ts.transpile(src, {target: ts.ScriptTarget.ES2015});`,
          `new Function("__tscptr__","console","String",compiled)(tscptr,console,String);`,
          `fs.writeFileSync("${typesFile}", JSON.stringify(ctx.getCollectedTypes()));`,
        ].join("\n"),
      );
      fs.writeFileSync(path.join(dir, "instrumented.ts"), instrumented);

      execFileSync("node", [runnerFile], { encoding: "utf-8", timeout: 15000 });
      execFileSync("node", [CLI, "apply", typesFile], { encoding: "utf-8" });

      const result = fs.readFileSync(srcFile, "utf-8");
      expect(result).toContain("val: number|string");
    });
  });
});

describe("E2E: Node runner (loader-based)", () => {
  it("instruments, collects, and applies types in one shot", () => {
    withTmpDir((dir) => {
      const srcFile = path.join(dir, "app.ts");
      fs.writeFileSync(
        srcFile,
        ['function greet(name) { return "Hello " + name; }', 'greet("World");', ""].join("\n"),
      );

      // Runner that simulates what register.ts + loader.ts do:
      // instrument → execute → collect → apply on exit
      const runnerFile = path.join(dir, "runner.mjs");
      fs.writeFileSync(
        runnerFile,
        [
          `import { instrumentSource } from "${DIST}/instrument.js";`,
          `import { createCollectionContext } from "${DIST}/type-collector.js";`,
          `import { applyTypesToFile } from "${DIST}/apply-types.js";`,
          `import fs from "node:fs";`,
          `import ts from "${TS_LIB}";`,
          ``,
          `const srcFile = "${srcFile}";`,
          `const source = fs.readFileSync(srcFile, "utf-8");`,
          ``,
          `// Phase 1: Instrument`,
          `const instrumented = instrumentSource(source, srcFile);`,
          ``,
          `// Phase 2: Set up collection context (like loader.ts does)`,
          `const ctx = createCollectionContext();`,
          ...buildTscptrScaffoldLines(),
          ``,
          `// Phase 3: Execute`,
          `const compiled = ts.transpile(instrumented, {target: ts.ScriptTarget.ES2015});`,
          `new Function("__tscptr__","console",compiled)(tscptr,console);`,
          ``,
          `// Phase 4: Apply on "exit" (like register.ts process.on("exit") does)`,
          `const types = ctx.getCollectedTypes().filter(([f]) => f === srcFile);`,
          `if (types.length > 0) {`,
          `  fs.writeFileSync(srcFile, applyTypesToFile(source, types, {}));`,
          `}`,
        ].join("\n"),
      );

      execFileSync("node", [runnerFile], { encoding: "utf-8", timeout: 15000 });

      const result = fs.readFileSync(srcFile, "utf-8");
      expect(result).toContain("name: string");
    });
  });

  it("handles class methods end-to-end", () => {
    withTmpDir((dir) => {
      const srcFile = path.join(dir, "greeter.ts");
      fs.writeFileSync(
        srcFile,
        [
          "class Greeter {",
          "  greet(who) { return 'Hello, ' + who; }",
          "}",
          "new Greeter().greet('World');",
          "",
        ].join("\n"),
      );

      const runnerFile = path.join(dir, "runner.mjs");
      fs.writeFileSync(
        runnerFile,
        [
          `import { instrumentSource } from "${DIST}/instrument.js";`,
          `import { createCollectionContext } from "${DIST}/type-collector.js";`,
          `import { applyTypesToFile } from "${DIST}/apply-types.js";`,
          `import fs from "node:fs";`,
          `import ts from "${TS_LIB}";`,
          `const srcFile = "${srcFile}";`,
          `const source = fs.readFileSync(srcFile, "utf-8");`,
          `const instrumented = instrumentSource(source, srcFile);`,
          `const ctx = createCollectionContext();`,
          ...buildTscptrScaffoldLines(),
          `const compiled = ts.transpile(instrumented, {target: ts.ScriptTarget.ES2015});`,
          `new Function("__tscptr__","console",compiled)(tscptr,console);`,
          `const types = ctx.getCollectedTypes().filter(([f]) => f === srcFile);`,
          `if (types.length > 0) fs.writeFileSync(srcFile, applyTypesToFile(source, types, {}));`,
        ].join("\n"),
      );

      execFileSync("node", [runnerFile], { encoding: "utf-8", timeout: 15000 });

      const result = fs.readFileSync(srcFile, "utf-8");
      expect(result).toContain("who: string");
    });
  });

  it("leaves files unchanged when no types collected", () => {
    withTmpDir((dir) => {
      const srcFile = path.join(dir, "unused.ts");
      const original = "function unused(x) { return x; }\n";
      fs.writeFileSync(srcFile, original);

      const runnerFile = path.join(dir, "runner.mjs");
      fs.writeFileSync(
        runnerFile,
        [
          `import { instrumentSource } from "${DIST}/instrument.js";`,
          `import { createCollectionContext } from "${DIST}/type-collector.js";`,
          `import { applyTypesToFile } from "${DIST}/apply-types.js";`,
          `import fs from "node:fs";`,
          `import ts from "${TS_LIB}";`,
          `const srcFile = "${srcFile}";`,
          `const source = fs.readFileSync(srcFile, "utf-8");`,
          `const instrumented = instrumentSource(source, srcFile);`,
          `const ctx = createCollectionContext();`,
          ...buildTscptrScaffoldLines(),
          `// Execute but never call the function`,
          `const compiled = ts.transpile(instrumented, {target: ts.ScriptTarget.ES2015});`,
          `new Function("__tscptr__","console",compiled)(tscptr,console);`,
          `const types = ctx.getCollectedTypes().filter(([f]) => f === srcFile);`,
          `if (types.length > 0) fs.writeFileSync(srcFile, applyTypesToFile(source, types, {}));`,
        ].join("\n"),
      );

      execFileSync("node", [runnerFile], { encoding: "utf-8", timeout: 15000 });

      const result = fs.readFileSync(srcFile, "utf-8");
      expect(result).toBe(original);
    });
  });
});
