import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildTscptrScaffoldLines } from "./test-tscptr-scaffold.js";
import { checked } from "./test-utils/applied.js";

const CLI = path.resolve("dist/cli.js");
const DIST = path.resolve("dist");
const TS_LIB = path.resolve("node_modules/typescript/lib/typescript.js");

function withTmpDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-e2e-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

function runNode(file: string): void {
  execFileSync("node", [file], { encoding: "utf-8", timeout: 15000 });
}

/**
 * Instrument and apply through the CLI, with a runner script in between that
 * transpiles, executes with the collector wired up, and dumps the types as
 * the CLI's `apply` reads them. `globals` are what the executed code needs
 * besides `console`. Returns the file's text afterwards.
 */
function throughCli(dir: string, name: string, content: string, globals: string[] = []): string {
  const srcFile = path.join(dir, name);
  fs.writeFileSync(srcFile, content);
  const instrumented = execFileSync("node", [CLI, "instrument", srcFile], { encoding: "utf-8" });
  fs.writeFileSync(path.join(dir, "instrumented.ts"), instrumented);

  const typesFile = path.join(dir, "types.json");
  const runnerFile = path.join(dir, "runner.mjs");
  const names = ["__tscptr__", "console", ...globals].map((n) => JSON.stringify(n));
  const values = ["tscptr", "console", ...globals];
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
      `new Function(${names.join(",")},compiled)(${values.join(",")});`,
      `fs.writeFileSync("${typesFile}", JSON.stringify(ctx.getCollectedTypes()));`,
    ].join("\n"),
  );
  runNode(runnerFile);
  execFileSync("node", [CLI, "apply", typesFile], { encoding: "utf-8" });
  return fs.readFileSync(srcFile, "utf-8");
}

/**
 * What register.ts and loader.ts do, as one script against the built package:
 * instrument, execute, collect, and apply on exit. Returns the file's text
 * afterwards.
 */
function throughRunner(dir: string, name: string, content: string): string {
  const srcFile = path.join(dir, name);
  fs.writeFileSync(srcFile, content);
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
  runNode(runnerFile);
  return fs.readFileSync(srcFile, "utf-8");
}

const GREET = 'function greet(name) { return "Hello " + name; }\ngreet("World");\n';

describe("E2E: CLI pipeline (instrument → run → apply)", () => {
  it("adds string type via full CLI flow", () => {
    withTmpDir((dir) => {
      const out = checked(GREET, throughCli(dir, "app.ts", GREET));
      expect(out).toTypeAs("name", "string");
      expect(out).toTypeAs({ returnOf: "greet" }, "string");
      expect(out).toHaveNoNewDiagnostics();
    });
  });

  it("adds number type to arrow function via CLI flow", () => {
    withTmpDir((dir) => {
      const input = "const double = (x) => x * 2;\ndouble(21);\n";
      const out = checked(input, throughCli(dir, "math.ts", input));
      expect(out).toTypeAs("x", "number");
      expect(out).toTypeAs({ returnOf: "double" }, "number");
      expect(out).toHaveNoNewDiagnostics();
    });
  });

  it("handles union types from multiple calls", () => {
    withTmpDir((dir) => {
      const input = 'function show(val) { return String(val); }\nshow("hello");\nshow(42);\n';
      const out = checked(input, throughCli(dir, "union.ts", input, ["String"]));
      expect(out).toTypeAs("val", "number | string");
      expect(out).toHaveNoNewDiagnostics();
    });
  });
});

describe("E2E: Node runner (loader-based)", () => {
  it("instruments, collects, and applies types in one shot", () => {
    withTmpDir((dir) => {
      const out = checked(GREET, throughRunner(dir, "app.ts", GREET));
      expect(out).toTypeAs("name", "string");
      expect(out).toTypeAs({ returnOf: "greet" }, "string");
      expect(out).toHaveNoNewDiagnostics();
    });
  });

  it("handles class methods end-to-end", () => {
    withTmpDir((dir) => {
      const input = [
        "class Greeter {",
        "  greet(who) { return 'Hello, ' + who; }",
        "}",
        "new Greeter().greet('World');",
        "",
      ].join("\n");
      const out = checked(input, throughRunner(dir, "greeter.ts", input));
      expect(out).toTypeAs("who", "string");
      expect(out).toTypeAs({ returnOf: "greet" }, "string");
      expect(out).toHaveNoNewDiagnostics();
    });
  });

  it("leaves files unchanged when no types collected", () => {
    withTmpDir((dir) => {
      // Untouched means byte for byte, so the text is the claim.
      const original = "function unused(x) { return x; }\n";
      expect(throughRunner(dir, "unused.ts", original)).toBe(original);
    });
  });
});
