import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { typeCoverage } from "./type-coverage.js";

function programFromSource(source: string): ts.Program {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-cov-"));
  const filePath = path.join(tmpDir, "test.ts");
  const configPath = path.join(tmpDir, "tsconfig.json");
  fs.writeFileSync(filePath, source);
  fs.writeFileSync(
    configPath,
    JSON.stringify({ compilerOptions: { strict: true }, include: ["test.ts"] }),
  );
  const program = ts.createProgram([filePath], { strict: true });
  // cleanup is best-effort
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {}
  return program;
}

describe("typeCoverage", () => {
  it("reports high coverage for fully annotated code", () => {
    const program = programFromSource("const x: number = 1; const y: string = 'hi';");
    const result = typeCoverage(program);
    expect(result.totalTypes).toBeGreaterThan(0);
    expect(result.percentage).toBeGreaterThan(50);
  });

  it("returns 0 for empty program with no source files", () => {
    // Create a program with only lib files
    const program = ts.createProgram([], { noLib: true });
    const result = typeCoverage(program);
    expect(result.totalTypes).toBe(0);
    expect(result.percentage).toBe(0);
  });

  it("detects 'any' types as unknown", () => {
    const program = programFromSource("let x: any = 1; const y: number = 2;");
    const result = typeCoverage(program);
    expect(result.knownTypes).toBeLessThan(result.totalTypes);
  });

  it("returns the three expected fields", () => {
    const program = programFromSource("const x = 1;");
    const result = typeCoverage(program);
    expect(result).toHaveProperty("knownTypes");
    expect(result).toHaveProperty("totalTypes");
    expect(result).toHaveProperty("percentage");
  });
});
