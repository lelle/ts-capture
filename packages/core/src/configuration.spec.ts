import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  findConfigFile,
  INFER_DEFAULTS,
  loadConfig,
  parseInferFlagOverrides,
  resolveApplyTypesOptions,
  resolveInferOptions,
  resolveInstrumentOptions,
  type TsCaptureConfig,
} from "./configuration.js";

function withTmpDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-capture-cfg-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe("findConfigFile", () => {
  it("finds ts-capture.config.json in the given directory", () => {
    withTmpDir((dir) => {
      fs.writeFileSync(path.join(dir, "ts-capture.config.json"), "{}");
      expect(findConfigFile(dir)).toBe(path.join(dir, "ts-capture.config.json"));
    });
  });

  it("walks up to parent directories", () => {
    withTmpDir((dir) => {
      const sub = path.join(dir, "a", "b");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(dir, "ts-capture.config.json"), "{}");
      expect(findConfigFile(sub)).toBe(path.join(dir, "ts-capture.config.json"));
    });
  });

  it("returns undefined when no config found", () => {
    withTmpDir((dir) => {
      expect(findConfigFile(dir)).toBeUndefined();
    });
  });
});

describe("loadConfig", () => {
  it("loads and parses a valid config file", () => {
    withTmpDir((dir) => {
      const cfgPath = path.join(dir, "ts-capture.config.json");
      fs.writeFileSync(cfgPath, JSON.stringify({ common: { rootDir: "./src" } }));
      const config = loadConfig(cfgPath);
      expect(config.common?.rootDir).toBe("./src");
    });
  });

  it("throws on missing file", () => {
    expect(() => loadConfig("/nonexistent/ts-capture.config.json")).toThrow(
      "Cannot read config file",
    );
  });

  it("throws on invalid JSON", () => {
    withTmpDir((dir) => {
      const cfgPath = path.join(dir, "ts-capture.config.json");
      fs.writeFileSync(cfgPath, "{ bad json }");
      expect(() => loadConfig(cfgPath)).toThrow("Invalid JSON");
    });
  });

  it("throws on non-object JSON", () => {
    withTmpDir((dir) => {
      const cfgPath = path.join(dir, "ts-capture.config.json");
      fs.writeFileSync(cfgPath, '"just a string"');
      expect(() => loadConfig(cfgPath)).toThrow("must be a JSON object");
    });
  });
});

describe("resolveInstrumentOptions", () => {
  it("merges common and instrument options", () => {
    const config = {
      common: { rootDir: "./src" },
      instrument: { instrumentCallExpressions: true },
    };
    const result = resolveInstrumentOptions(config);
    expect(result.rootDir).toBe("./src");
    expect(result.instrumentCallExpressions).toBe(true);
  });

  it("resolves relative paths from configDir", () => {
    const config = { common: { rootDir: "./src", tsConfig: "./tsconfig.json" } };
    const result = resolveInstrumentOptions(config, "/project");
    expect(result.rootDir).toBe(path.resolve("/project", "./src"));
    expect(result.tsConfig).toBe(path.resolve("/project", "./tsconfig.json"));
  });
});

describe("resolveApplyTypesOptions", () => {
  it("merges common and applyTypes options", () => {
    const config = {
      common: { rootDir: "./src" },
      applyTypes: { prefix: "/*tw*/" },
    };
    const result = resolveApplyTypesOptions(config);
    expect(result.rootDir).toBe("./src");
    expect(result.prefix).toBe("/*tw*/");
  });
});

describe("InferOptions", () => {
  it("INFER_DEFAULTS has every flag pre-populated", () => {
    expect(INFER_DEFAULTS.recursiveObjectMerge).toBe(true);
    expect(INFER_DEFAULTS.crossSampleArrayMerge).toBe(false);
    expect(INFER_DEFAULTS.rewriteCommonBase).toBe(false);
    expect(INFER_DEFAULTS.skipInferableVarDecls).toBe(false);
    // cstAware defaults to ON — the CST applier produces zero
    // regressions vs the offset-based path on real codebases and is
    // strictly more correct in two documented cases. See
    // `apply-types-cst.ts` for details.
    expect(INFER_DEFAULTS.cstAware).toBe(true);
    expect(INFER_DEFAULTS.literal.string).toBe(false);
    expect(INFER_DEFAULTS.literal.stringMaxLength).toBe(16);
    expect(INFER_DEFAULTS.literal.number).toBe(false);
    expect(INFER_DEFAULTS.literal.boolean).toBe(false);
    expect(INFER_DEFAULTS.patternDetection.isoDate).toBe(false);
    expect(INFER_DEFAULTS.patternDetection.uuid).toBe(false);
    expect(INFER_DEFAULTS.patternDetection.url).toBe(false);
    expect(INFER_DEFAULTS.narrowOptional.preferUndefinedOverNull).toBe(true);
  });

  describe("resolveInferOptions", () => {
    it("returns defaults when config has no infer section", () => {
      expect(resolveInferOptions({})).toEqual(INFER_DEFAULTS);
    });

    it("respects partial top-level overrides", () => {
      const resolved = resolveInferOptions({
        infer: { recursiveObjectMerge: false },
      });
      expect(resolved.recursiveObjectMerge).toBe(false);
      expect(resolved.crossSampleArrayMerge).toBe(false);
      expect(resolved.literal.stringMaxLength).toBe(16);
    });

    it("respects nested partial overrides", () => {
      const resolved = resolveInferOptions({
        infer: { literal: { string: true, stringMaxLength: 24 } },
      });
      expect(resolved.literal.string).toBe(true);
      expect(resolved.literal.stringMaxLength).toBe(24);
      expect(resolved.literal.number).toBe(false);
    });

    it("does not mutate the input config", () => {
      const config: TsCaptureConfig = { infer: { literal: { string: true } } };
      const before = JSON.stringify(config);
      resolveInferOptions(config);
      expect(JSON.stringify(config)).toBe(before);
    });
  });

  describe("parseInferFlagOverrides", () => {
    it("returns empty object for no --infer flags", () => {
      expect(parseInferFlagOverrides(["--other=true", "value"])).toEqual({});
    });

    it("parses a single boolean flag", () => {
      expect(parseInferFlagOverrides(["--infer.recursiveObjectMerge=false"])).toEqual({
        recursiveObjectMerge: false,
      });
    });

    it("parses a nested dot-path", () => {
      expect(parseInferFlagOverrides(["--infer.literal.string=true"])).toEqual({
        literal: { string: true },
      });
    });

    it("merges multiple flags into one nested object", () => {
      expect(
        parseInferFlagOverrides([
          "--infer.literal.string=true",
          "--infer.literal.stringMaxLength=24",
          "--infer.crossSampleArrayMerge=true",
        ]),
      ).toEqual({
        literal: { string: true, stringMaxLength: 24 },
        crossSampleArrayMerge: true,
      });
    });

    it("coerces numeric strings to numbers", () => {
      const r = parseInferFlagOverrides(["--infer.literal.stringMaxLength=42"]);
      expect(r).toEqual({ literal: { stringMaxLength: 42 } });
    });

    it("treats unrecognized values as strings", () => {
      expect(parseInferFlagOverrides(["--infer.someKey=hello"])).toEqual({
        someKey: "hello",
      });
    });

    it("ignores --infer flags without =value", () => {
      expect(parseInferFlagOverrides(["--infer.literal.string"])).toEqual({});
    });
  });
});
