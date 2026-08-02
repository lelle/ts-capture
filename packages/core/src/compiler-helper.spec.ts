import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getProgram } from "./compiler-helper.js";

describe("getProgram", () => {
  it("returns undefined when no tsConfig is provided", () => {
    const result = getProgram({});
    expect(result).toBeUndefined();
  });

  it("returns a Program for a valid tsconfig", () => {
    // Create a temporary tsconfig
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-test-"));
    const tsConfigPath = path.join(tmpDir, "tsconfig.json");
    const srcPath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(
      tsConfigPath,
      JSON.stringify({ compilerOptions: { strict: true }, include: ["test.ts"] }),
    );
    fs.writeFileSync(srcPath, "const x: number = 1;");

    try {
      const program = getProgram({ tsConfig: tsConfigPath, rootDir: tmpDir });
      expect(program).toBeDefined();
      expect(program!.getSourceFiles().length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("throws with file path when tsconfig does not exist", () => {
    expect(() => getProgram({ tsConfig: "/nonexistent/tsconfig.json" })).toThrow(
      /nonexistent\/tsconfig\.json/,
    );
  });

  it("throws with details when tsconfig has parse errors", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-test-"));
    const tsConfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(tsConfigPath, "{ invalid json }");

    try {
      expect(() => getProgram({ tsConfig: tsConfigPath })).toThrow(tsConfigPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
