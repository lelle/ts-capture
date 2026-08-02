import { describe, expect, it } from "vitest";

import * as api from "./index.js";

describe("public API", () => {
  const expectedExports = [
    // Core pipeline
    "instrumentSource",
    "applyTypesToFile",
    "applyTypesToFileCst",
    "applyTypesToFiles",
    "typeCoverage",
    "verifyTypes",
    "isCompatible",
    "instrumentBundle",
    "translateBundleObservations",
    "resolveInferOptions",
    "parseInferFlagOverrides",
    "INFER_DEFAULTS",

    // Type collector
    "getTypeName",
    "wasDepthExceeded",
    "createCollectionContext",

    // AST transformation
    "tsCaptureTransformer",
    "transformSourceFile",

    // Building blocks
    "Replacement",
    "applyReplacements",
    "getProgram",
    "findConfigFile",
    "loadConfig",
    "resolveInstrumentOptions",
    "resolveApplyTypesOptions",

    // Applier plugins
    "routeFile",
    "loadPluginsFromConfig",

    // Verification
    "createProjectVerificationContext",
    "createVerificationContext",
    "registerVirtualFile",
  ];

  for (const name of expectedExports) {
    it(`exports ${name}`, () => {
      expect(api).toHaveProperty(name);
      expect(typeof (api as Record<string, unknown>)[name]).not.toBe("undefined");
    });
  }

  it("does not export unexpected items", () => {
    const actual = Object.keys(api).sort();
    expect(actual).toEqual([...expectedExports].sort());
  });
});
