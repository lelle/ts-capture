import { INFER_DEFAULTS } from "@ts-capture/core/browser";
import { describe, expect, it } from "vitest";

import { changedOptions, OPTION_DEFAULTS } from "./options.js";

describe("the playground's options", () => {
  it("start where ts-capture's own defaults are", () => {
    for (const [key, value] of Object.entries(OPTION_DEFAULTS)) {
      expect(INFER_DEFAULTS).toHaveProperty(key, value);
    }
  });

  it("count as changed only where they differ from the defaults", () => {
    expect(
      changedOptions({
        ...OPTION_DEFAULTS,
        aliasRepeatedShapes: true,
        outputMode: "annotations",
      }),
    ).toEqual({ aliasRepeatedShapes: true });
  });
});
