import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { applyInMemory, createObserver, instrumentSource, reportLines } from "./browser.js";

const libDir = path.dirname(ts.getDefaultLibFilePath({}));

const memorySystem = (files: Record<string, string>): ts.System => {
  const read = (file: string): string | undefined =>
    file.startsWith("/ts/") ? ts.sys.readFile(path.join(libDir, file.slice(4))) : files[file];
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
};

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
};

async function observe(source: string, file: string) {
  const observer = createObserver();
  const js = ts.transpileModule(instrumentSource(source, file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  new Function("__tscptr__", js)(observer.hook);
  return observer.collect();
}

const CART = `function total(cart) {
  return cart.lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
}
function label(user) {
  return user.name.toUpperCase();
}
async function load(id) {
  return { id, tags: ["a"] };
}
total({ lines: [{ price: 2, quantity: 3 }] });
label({ name: "Ada" });
load(1);
`;

describe("@ts-capture/core/browser", () => {
  it("bundles for a browser without a Node module", async () => {
    const result = await build({
      entryPoints: [path.resolve("src/browser.ts")],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
      metafile: true,
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((input) => input.startsWith("node:"))).toEqual([]);
    expect(inputs).toContain("src/apply-types-verify.ts");
  });

  it("observes a run and applies it against a project held in memory", async () => {
    const types = await observe(CART, "/demo.ts");
    const result = applyInMemory({
      fileNames: ["/demo.ts"],
      types,
      compilerOptions,
      rootDir: "/",
      system: memorySystem({ "/demo.ts": CART }),
    });
    const after = result.files["/demo.ts"];
    expect(after).toContain(
      "function total(cart: { lines: { price: number; quantity: number }[] }): number {",
    );
    expect(after).toContain("function label(user: { name: string }): string {");
    expect(after).toContain(
      "async function load(id: number): Promise<{ id: number; tags: string[] }> {",
    );
    expect(result.telemetry.emitted).toBeGreaterThanOrEqual(6);
  });

  it("leaves out an annotation the project would not compile with, and says why", async () => {
    const source = `const pick = (items, key) => items.map((item) => item[key]);
pick([{ sku: "a", price: 2 }], "sku");
`;
    const types = await observe(source, "/demo.ts");
    const result = applyInMemory({
      fileNames: ["/demo.ts"],
      types,
      compilerOptions,
      rootDir: "/",
      system: memorySystem({ "/demo.ts": source }),
    });
    const program = ts.createProgram({
      rootNames: ["/demo.ts"],
      options: compilerOptions,
      host: {
        ...ts.createCompilerHost(compilerOptions),
        ...hostOver(memorySystem({ "/demo.ts": result.files["/demo.ts"] })),
      },
    });
    const errorsBefore = diagnosticCount(source);
    expect(ts.getPreEmitDiagnostics(program).length).toBeLessThanOrEqual(errorsBefore);
    const rejected = result.skips.filter((skip) => skip.reason === "type-error");
    expect(rejected.length).toBeGreaterThan(0);
    expect(reportLines(result.telemetry, result.skips).join("\n")).toContain(
      "Would add a type error",
    );
  });

  it("writes what the CLI writes for the same file and observations", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-browser-")));
    try {
      const file = path.join(dir, "demo.ts");
      fs.writeFileSync(file, CART);
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
          },
          files: ["demo.ts"],
        }),
      );
      const types = await observe(CART, file);
      fs.writeFileSync(path.join(dir, "types.json"), JSON.stringify(types));
      const inMemory = applyInMemory({
        fileNames: [file],
        types,
        compilerOptions,
        rootDir: dir,
        system: { ...ts.sys, getExecutingFilePath: () => path.join(libDir, "typescript.js") },
      });
      execFileSync("node", [path.resolve("dist/cli.js"), "apply", "types.json"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(inMemory.files[file]).toBe(fs.readFileSync(file, "utf-8"));
      expect(inMemory.files[file]).not.toBe(CART);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function hostOver(system: ts.System): Partial<ts.CompilerHost> {
  return {
    fileExists: system.fileExists,
    readFile: system.readFile,
    getDefaultLibFileName: (options) => `/ts/${ts.getDefaultLibFileName(options)}`,
    getSourceFile: (file, languageVersion) => {
      const text = system.readFile(file);
      return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion);
    },
  };
}

function diagnosticCount(source: string): number {
  const system = memorySystem({ "/demo.ts": source });
  const program = ts.createProgram({
    rootNames: ["/demo.ts"],
    options: compilerOptions,
    host: { ...ts.createCompilerHost(compilerOptions), ...hostOver(system) },
  });
  return ts.getPreEmitDiagnostics(program).length;
}
