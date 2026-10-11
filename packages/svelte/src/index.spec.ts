import type { CollectedTypeInfo } from "@ts-capture/core";

import { getTypeName } from "@ts-capture/core";
import { describe, expect, it } from "vitest";

import { entry } from "../../core/src/test-utils/applied.js";
import {
  endOf,
  inspected,
  type Instrumented,
} from "../../core/src/test-utils/instrumented.js";
import "../../core/src/test-utils/matchers.js";
import { applySvelteTypesToFile } from "./apply.js";
import {
  sveltePlugin,
  sveltePreprocessor,
  type SveltePreprocessorOptions,
} from "./index.js";
import { attachPeek } from "./runes.js";
import { appliedSvelte } from "./test-utils/applied-svelte.js";

// ---------------------------------------------------------------------------
// sveltePreprocessor
// ---------------------------------------------------------------------------

/**
 * Preprocess a `lang="ts"` script block and hold the result against its
 * content: it parses, records at sites of the content, and is the content
 * plus calls.
 */
function preprocessed(
  content: string,
  block: {
    filename?: string;
    context?: "module";
    options?: SveltePreprocessorOptions;
  } = {},
): Instrumented {
  const attributes: Record<string, string> = { lang: "ts" };
  if (block.context) attributes.context = block.context;
  const { code } = sveltePreprocessor(block.options).script({
    content,
    attributes,
    filename: block.filename,
  });
  const base = block.filename ?? "component.svelte";
  const suffix = block.context === "module" ? "__module" : "__script";
  return inspected(code, {
    input: content,
    filename: `${base}${suffix}.ts`,
    additive: true,
  });
}

const IN_COMP = { filename: "comp.svelte" };

describe("sveltePreprocessor", () => {
  it("instruments a function parameter", () => {
    expect(preprocessed("function foo(a) {}", IN_COMP)).toTrack("a", {
      in: "comp.svelte__script.ts",
    });
  });

  it("uses __module suffix for context=module blocks", () => {
    expect(
      preprocessed("export const x = 1", { ...IN_COMP, context: "module" }),
    ).toWrapInitializerOf("x", { in: "comp.svelte__module.ts" });
  });

  it("returns content unchanged when lang attribute is absent", () => {
    // Svelte preprocessors run on every <script> block, including ones
    // without lang="ts" (e.g. SvelteKit's generated root.svelte). Treating
    // those as TS injects `declare` statements into plain-JS source and
    // breaks the Svelte compile step. Skip when lang is anything other
    // than "ts".
    const pp = sveltePreprocessor();
    const content = "let x = 1";
    const { code } = pp.script({
      content,
      attributes: {},
      filename: "comp.svelte",
    });
    expect(code).toBe(content);
  });

  it("returns content unchanged when lang is js", () => {
    const pp = sveltePreprocessor();
    const content = "let x = 1";
    const { code } = pp.script({
      content,
      attributes: { lang: "js" },
      filename: "comp.svelte",
    });
    expect(code).toBe(content);
  });

  it("falls back to component.svelte when filename is absent", () => {
    expect(preprocessed("let x = 1")).toWrapInitializerOf("x", {
      in: "component.svelte__script.ts",
    });
  });

  it("does not modify markup outside the script block", () => {
    // The preprocessor returns only the transformed script content, and
    // preprocessed() rejects a result that is more than that content plus
    // calls. The text check says the same of markup in particular.
    const out = preprocessed("function foo(a) {}", IN_COMP);
    expect(out.text).not.toContain("<p>");
    expect(out.text).not.toContain("</script>");
  });

  // Svelte 5 runes must remain the direct RHS of variable declarations /
  // class fields. The preprocessor opts out of __tscptr__.ret wrapping
  // for any $-prefixed call by passing skipInitializerCalleeWhen to
  // instrumentSource. This is Svelte-specific POLICY; the underlying
  // skip mechanism lives in @ts-capture/core.
  describe("Svelte 5 rune placement", () => {
    it("does NOT wrap a $derived(...) initializer", () => {
      expect(
        preprocessed(
          "let visibleAlerts = $derived(items.slice(0, 3));",
          IN_COMP,
        ),
      ).not.toWrapInitializerOf("visibleAlerts");
    });

    it("does NOT wrap $state(...)", () => {
      expect(
        preprocessed("let count = $state(0);", IN_COMP),
      ).not.toWrapInitializerOf("count");
    });

    it("does NOT wrap rune member calls ($state.raw, $derived.by)", () => {
      const out = preprocessed(
        "let frozen = $state.raw(0); let by = $derived.by(() => 1);",
        IN_COMP,
      );
      expect(out).not.toWrapInitializerOf("frozen");
      expect(out).not.toWrapInitializerOf("by");
    });

    it("does NOT wrap class field initialized with a rune", () => {
      expect(
        preprocessed("class C { count = $state(0); }", IN_COMP),
      ).not.toWrapInitializerOf("count");
    });

    it("STILL wraps non-rune initializers (regression)", () => {
      expect(
        preprocessed("let x = computeValue();", IN_COMP),
      ).toWrapInitializerOf("x");
    });

    it("composes with caller-provided skipInitializerCalleeWhen", () => {
      const out = preprocessed(
        "let a = $state(0); let b = myFn(1); let c = other();",
        {
          ...IN_COMP,
          options: { skipInitializerCalleeWhen: (name) => name === "myFn" },
        },
      );
      // The rune by Svelte's policy, myFn by the caller's.
      expect(out).not.toWrapInitializerOf("a");
      expect(out).not.toWrapInitializerOf("b");
      expect(out).toWrapInitializerOf("c");
    });
  });
});

// ---------------------------------------------------------------------------
// applySvelteTypesToFile
// ---------------------------------------------------------------------------

// The content of a script block. An entry's offset is relative to it.
const FOO = "\nfunction foo(a) {}\n";
const MOD = "\nfunction mod(a) {}\n";

describe("applySvelteTypesToFile", () => {
  it("applies annotation at the correct position in the .svelte file", () => {
    const svelteSource = `<script lang="ts">${FOO}</script>`;
    const typeInfo: CollectedTypeInfo = [
      entry("comp.svelte__script.ts", endOf(FOO, "(a"), [["string"]]),
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    expect(appliedSvelte(svelteSource, result).script).toAnnotate(
      "a",
      "string",
    );
  });

  it("handles <script context='module'> blocks", () => {
    const svelteSource = `<script context="module" lang="ts">${MOD}</script>`;
    const typeInfo: CollectedTypeInfo = [
      entry("comp.svelte__module.ts", endOf(MOD, "(a"), [["number"]]),
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    expect(appliedSvelte(svelteSource, result).module).toAnnotate(
      "a",
      "number",
    );
  });

  it("returns source unchanged when no script block is present", () => {
    const svelteSource = "<p>No script here</p>";
    const typeInfo: CollectedTypeInfo = [
      ["comp.svelte__script.ts", 5, [["string", undefined]], {}],
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    expect(result).toBe(svelteSource);
  });

  it("returns source unchanged when typeInfo has no matching entries", () => {
    const svelteSource = `<script lang="ts">${FOO}</script>`;
    const typeInfo: CollectedTypeInfo = [
      // Wrong svelteFilename prefix — no match
      entry("other.svelte__script.ts", endOf(FOO, "(a"), [["string"]]),
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    expect(result).toBe(svelteSource);
  });

  it("handles both instance and module script blocks in the same file", () => {
    const inst = "\nfunction inst(b) {}\n";
    const svelteSource = [
      `<script context="module" lang="ts">${MOD}</script>`,
      `<script lang="ts">${inst}</script>`,
    ].join("\n");
    const typeInfo: CollectedTypeInfo = [
      entry("comp.svelte__module.ts", endOf(MOD, "(a"), [["string"]]),
      entry("comp.svelte__script.ts", endOf(inst, "(b"), [["number"]]),
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    const out = appliedSvelte(svelteSource, result);
    expect(out.module).toAnnotate("a", "string");
    expect(out.script).toAnnotate("b", "number");
  });
});

// ---------------------------------------------------------------------------
// attachPeek (@ts-capture/svelte/runes)
// ---------------------------------------------------------------------------

describe("sveltePlugin", () => {
  // Same fixture as the applySvelteTypesToFile tests above: a tiny
  // .svelte file with a single un-typed function param. The plugin's
  // job is to receive (source, entries, opts) from cmdApply and
  // forward to applySvelteTypesToFile with the right svelteFilename
  // wiring.
  it("match() claims synthetic *.svelte__script.ts paths", () => {
    const plugin = sveltePlugin();
    expect(plugin.match("Component.svelte__script.ts")).toBe(true);
    expect(plugin.match("/abs/path/Foo.svelte__module.ts")).toBe(true);
    expect(plugin.match("Component.svelte")).toBe(false);
    expect(plugin.match("regular.ts")).toBe(false);
    expect(plugin.match("svelte-utils.ts")).toBe(false);
  });

  it("resolveSourceFile() strips the virtual suffix back to the .svelte path", () => {
    const plugin = sveltePlugin();
    expect(plugin.resolveSourceFile("Foo.svelte__script.ts")).toBe(
      "Foo.svelte",
    );
    expect(plugin.resolveSourceFile("/abs/Bar.svelte__module.ts")).toBe(
      "/abs/Bar.svelte",
    );
  });

  it("apply() forwards to applySvelteTypesToFile with svelteFilename from options.filename", () => {
    // End-to-end through the plugin: the source is the .svelte file's
    // full text, entries carry the virtual __script.ts path, options
    // has filename set to the resolved .svelte path (as cmdApply
    // sends it). Plugin must wire svelteFilename so the apply finds
    // the entry's prefix match.
    const svelteSource = `<script lang="ts">${FOO}</script>`;
    const typeInfo: CollectedTypeInfo = [
      entry("comp.svelte__script.ts", endOf(FOO, "(a"), [["string"]]),
    ];
    const plugin = sveltePlugin();
    const result = plugin.apply(svelteSource, typeInfo, {
      filename: "comp.svelte",
    });
    expect(appliedSvelte(svelteSource, result).script).toAnnotate(
      "a",
      "string",
    );
  });
});

describe("attachPeek", () => {
  it("returns the same value (identity)", () => {
    const obj = { x: 1 };
    expect(attachPeek(obj)).toBe(obj);
  });

  it("attaches Symbol.for('ts-capture.peek') as a function", () => {
    const obj = { x: 1 };
    attachPeek(obj);
    const peek = (obj as Record<symbol, unknown>)[
      Symbol.for("ts-capture.peek")
    ];
    expect(typeof peek).toBe("function");
  });

  it("peek returns a plain snapshot — ts-capture getTypeName sees the data shape", () => {
    // Simulate what $state({ name: "alice", age: 30 }) would produce at runtime
    // by using a plain object (we can't call $state outside a Svelte context).
    // The peek protocol attaches snapshot; getTypeName should see the object shape.
    const obj = { name: "alice", age: 30 };
    attachPeek(obj);
    expect(getTypeName(obj)).toBe("{ age: number, name: string }");
  });

  it("peek function calls snapshot on the value", () => {
    const obj = { a: 1, b: "hello" };
    attachPeek(obj);
    const peek = (obj as Record<symbol, () => unknown>)[
      Symbol.for("ts-capture.peek")
    ];
    const result = peek();
    expect(result).toEqual({ a: 1, b: "hello" });
  });
});
