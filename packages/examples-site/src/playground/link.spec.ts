import { describe, expect, it } from "vitest";

import { linkFromHash, playgroundLink } from "./link.js";

describe("playgroundLink", () => {
  const code = 'greet({ name: "Ada & Bo" });\n';

  it("carries the code alone when every option is the default", () => {
    expect(playgroundLink(code, { aliasRepeatedShapes: false })).toBe(
      `#code=${encodeURIComponent(code)}`,
    );
  });

  it("carries the options that differ from the defaults, after the code", () => {
    expect(
      playgroundLink(code, {
        skipRedundantAnnotations: false,
        outputMode: "comments",
      }),
    ).toBe(
      `#code=${encodeURIComponent(code)}&infer.skipRedundantAnnotations=false&infer.outputMode=comments`,
    );
  });

  it("has no link for an option the playground cannot set", () => {
    expect(playgroundLink(code, { maxAnnotationChars: 300 })).toBeUndefined();
  });
});

describe("linkFromHash", () => {
  it("reads back the code and the options a link carries", () => {
    const code = "const a = 1; // 100% & more\n";
    const options = {
      narrowParamShapes: true,
      outputMode: "both",
    } as const;
    expect(linkFromHash(playgroundLink(code, options)!)).toEqual({
      code,
      options,
    });
  });

  it("reads a link from before the options, with the code alone", () => {
    expect(linkFromHash(`#code=${encodeURIComponent("f();\n")}`)).toEqual({
      code: "f();\n",
      options: {},
    });
  });

  it("passes over an option it does not know, or a value it cannot use", () => {
    expect(
      linkFromHash(
        "#code=f()&infer.literal.string=true&infer.outputMode=loud&infer.narrowParamShapes=yes",
      ),
    ).toEqual({ code: "f()", options: {} });
  });

  it("is undefined for a page opened without code", () => {
    expect(linkFromHash("")).toBeUndefined();
    expect(linkFromHash("#starter=cart")).toBeUndefined();
  });

  it("is undefined for a link that does not decode", () => {
    expect(linkFromHash("#code=%E0%A4%A")).toBeUndefined();
  });
});
