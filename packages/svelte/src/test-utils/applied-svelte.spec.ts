import { describe, expect, it } from "vitest";

import "../../../core/src/test-utils/matchers.js";
import { appliedSvelte } from "./applied-svelte.js";

const INPUT = [
  '<script context="module" lang="ts">',
  "function mod(a) {}",
  "</script>",
  '<script lang="ts">',
  "function inst(b) {}",
  "</script>",
  "<p>hi</p>",
].join("\n");

describe("appliedSvelte", () => {
  it("holds each script block as its own TypeScript file", () => {
    const out = appliedSvelte(
      INPUT,
      INPUT.replace("mod(a)", "mod(a: string)").replace(
        "inst(b)",
        "inst(b: number)",
      ),
    );
    expect(out.module).toAnnotate("a", "string");
    expect(out.script).toAnnotate("b", "number");
  });

  it("sees a block the applier left alone as untyped", () => {
    const out = appliedSvelte(INPUT, INPUT.replace("mod(a)", "mod(a: string)"));
    expect(out.script).toLeaveUntyped("b");
  });

  it("has no block where the file has none", () => {
    const out = appliedSvelte("<p>hi</p>", "<p>hi</p>");
    expect(out.script).toBeUndefined();
    expect(out.module).toBeUndefined();
  });

  it("rejects an output whose markup changed", () => {
    expect(() =>
      appliedSvelte(INPUT, INPUT.replace("<p>hi</p>", "<p>ho</p>")),
    ).toThrow(/outside its script blocks/);
  });

  it("rejects an output whose script tag changed", () => {
    expect(() =>
      appliedSvelte(INPUT, INPUT.replace('<script lang="ts">', "<script>")),
    ).toThrow(/outside its script blocks/);
  });

  it("type-checks a block against the other files of the project", () => {
    const input =
      "<script lang=\"ts\">\nimport { get } from './ctx'\nconst v = get()\n</script>";
    const files = {
      "ctx.ts":
        "export function get(): string | undefined { return undefined }\n",
    };
    expect(
      appliedSvelte(input, input.replace("const v", "const v: string"), {
        files,
      }).script,
    ).not.toHaveNoNewDiagnostics();
    expect(
      appliedSvelte(
        input,
        input.replace("const v", "const v: string | undefined"),
        { files },
      ).script,
    ).toHaveNoNewDiagnostics();
  });
});
