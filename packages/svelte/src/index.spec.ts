import type { CollectedTypeInfo } from "@ts-capture/core";

import { getTypeName } from "@ts-capture/core";
import { describe, expect, it } from "vitest";

import { applySvelteTypesToFile } from "./apply.js";
import { sveltePlugin, sveltePreprocessor } from "./index.js";
import { attachPeek } from "./runes.js";

// ---------------------------------------------------------------------------
// sveltePreprocessor
// ---------------------------------------------------------------------------

describe("sveltePreprocessor", () => {
  it("instruments a function parameter", () => {
    const pp = sveltePreprocessor();
    const { code } = pp.script({
      content: "function foo(a) {}",
      attributes: { lang: "ts" },
      filename: "comp.svelte",
    });
    expect(code).toContain("__tscptr__");
    expect(code).toContain('"comp.svelte__script.ts"');
  });

  it("uses __module suffix for context=module blocks", () => {
    const pp = sveltePreprocessor();
    const { code } = pp.script({
      content: "export const x = 1",
      attributes: { lang: "ts", context: "module" },
      filename: "comp.svelte",
    });
    expect(code).toContain('"comp.svelte__module.ts"');
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
    const pp = sveltePreprocessor();
    const { code } = pp.script({
      content: "let x = 1",
      attributes: { lang: "ts" },
    });
    expect(code).toContain('"component.svelte__script.ts"');
  });

  it("does not modify markup outside the script block", () => {
    const pp = sveltePreprocessor();
    const { code } = pp.script({
      content: "function foo(a) {}",
      attributes: { lang: "ts" },
      filename: "comp.svelte",
    });
    // The preprocessor returns only the transformed script content.
    // Template markup is not part of `content` — verify the result does
    // not accidentally contain HTML tags.
    expect(code).not.toContain("<p>");
    expect(code).not.toContain("</script>");
  });

  // Svelte 5 runes must remain the direct RHS of variable declarations /
  // class fields. The preprocessor opts out of __tscptr__.ret wrapping
  // for any $-prefixed call by passing skipInitializerCalleeWhen to
  // instrumentSource. This is Svelte-specific POLICY; the underlying
  // skip mechanism lives in @ts-capture/core.
  describe("Svelte 5 rune placement", () => {
    it("does NOT wrap a $derived(...) initializer", () => {
      const pp = sveltePreprocessor();
      const { code } = pp.script({
        content: "let visibleAlerts = $derived(items.slice(0, 3));",
        attributes: { lang: "ts" },
        filename: "comp.svelte",
      });
      expect(code).toMatch(/let visibleAlerts = \$derived\(/);
      expect(code).not.toMatch(/__tscptr__\.ret\(\s*\$derived/);
    });

    it("does NOT wrap $state(...)", () => {
      const pp = sveltePreprocessor();
      const { code } = pp.script({
        content: "let count = $state(0);",
        attributes: { lang: "ts" },
        filename: "comp.svelte",
      });
      expect(code).toMatch(/let count = \$state\(0\)/);
      expect(code).not.toMatch(/__tscptr__\.ret\(\s*\$state/);
    });

    it("does NOT wrap rune member calls ($state.raw, $derived.by)", () => {
      const pp = sveltePreprocessor();
      const { code } = pp.script({
        content: "let frozen = $state.raw(0); let by = $derived.by(() => 1);",
        attributes: { lang: "ts" },
        filename: "comp.svelte",
      });
      expect(code).toMatch(/let frozen = \$state\.raw\(0\)/);
      expect(code).toMatch(/let by = \$derived\.by\(/);
      expect(code).not.toMatch(/__tscptr__\.ret\(\s*\$state/);
      expect(code).not.toMatch(/__tscptr__\.ret\(\s*\$derived/);
    });

    it("does NOT wrap class field initialized with a rune", () => {
      const pp = sveltePreprocessor();
      const { code } = pp.script({
        content: "class C { count = $state(0); }",
        attributes: { lang: "ts" },
        filename: "comp.svelte",
      });
      expect(code).toMatch(/count = \$state\(0\)/);
      expect(code).not.toMatch(/__tscptr__\.ret\(\s*\$state/);
    });

    it("STILL wraps non-rune initializers (regression)", () => {
      const pp = sveltePreprocessor();
      const { code } = pp.script({
        content: "let x = computeValue();",
        attributes: { lang: "ts" },
        filename: "comp.svelte",
      });
      expect(code).toMatch(/__tscptr__\.ret\(computeValue\(\)/);
    });

    it("composes with caller-provided skipInitializerCalleeWhen", () => {
      const pp = sveltePreprocessor({
        skipInitializerCalleeWhen: (name) => name === "myFn",
      });
      const { code } = pp.script({
        content: "let a = $state(0); let b = myFn(1); let c = other();",
        attributes: { lang: "ts" },
        filename: "comp.svelte",
      });
      // rune skipped (Svelte default policy)
      expect(code).not.toMatch(/__tscptr__\.ret\(\s*\$state/);
      // caller-skipped
      expect(code).not.toMatch(/__tscptr__\.ret\(\s*myFn/);
      // not skipped
      expect(code).toMatch(/__tscptr__\.ret\(other\(\)/);
    });
  });
});

// ---------------------------------------------------------------------------
// applySvelteTypesToFile
// ---------------------------------------------------------------------------

describe("applySvelteTypesToFile", () => {
  // "\nfunction foo(a) {}\n" — `a.end` = 15 (verified via instrumentSource())
  const PARAM_A_END = 15;

  it("applies annotation at the correct position in the .svelte file", () => {
    const svelteSource = '<script lang="ts">\nfunction foo(a) {}\n</script>';
    const typeInfo: CollectedTypeInfo = [
      ["comp.svelte__script.ts", PARAM_A_END, [["string", undefined]], {}],
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    expect(result).toContain("function foo(a: string) {}");
    // Markup outside the script block must be untouched.
    expect(result).toContain("<script");
    expect(result).toContain("</script>");
  });

  it("handles <script context='module'> blocks", () => {
    const svelteSource =
      '<script context="module" lang="ts">\nfunction mod(a) {}\n</script>';
    const typeInfo: CollectedTypeInfo = [
      ["comp.svelte__module.ts", PARAM_A_END, [["number", undefined]], {}],
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    expect(result).toContain("function mod(a: number) {}");
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
    const svelteSource = '<script lang="ts">\nfunction foo(a) {}\n</script>';
    const typeInfo: CollectedTypeInfo = [
      // Wrong svelteFilename prefix — no match
      ["other.svelte__script.ts", PARAM_A_END, [["string", undefined]], {}],
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    expect(result).toBe(svelteSource);
  });

  it("handles both instance and module script blocks in the same file", () => {
    const svelteSource = [
      '<script context="module" lang="ts">',
      "function mod(a) {}",
      "</script>",
      '<script lang="ts">',
      "function inst(b) {}",
      "</script>",
    ].join("\n");

    // `a.end` in "\nfunction mod(a) {}\n" = 15
    // `b.end` in "\nfunction inst(b) {}\n" = 16 ("function inst(" is 14 chars + \n)
    // Verified: "\nfunction inst(b)" — \n=0, f=1..n=8, ` `=9, i=10,n=11,s=12,t=13, `(`=14, `b`=15, b.end=16
    const typeInfo: CollectedTypeInfo = [
      ["comp.svelte__module.ts", PARAM_A_END, [["string", undefined]], {}],
      ["comp.svelte__script.ts", 16, [["number", undefined]], {}],
    ];
    const result = applySvelteTypesToFile(svelteSource, typeInfo, {
      svelteFilename: "comp.svelte",
    });
    expect(result).toContain("function mod(a: string) {}");
    expect(result).toContain("function inst(b: number) {}");
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
  const PARAM_A_END = 15;

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
    const svelteSource = '<script lang="ts">\nfunction foo(a) {}\n</script>';
    const typeInfo: CollectedTypeInfo = [
      ["comp.svelte__script.ts", PARAM_A_END, [["string", undefined]], {}],
    ];
    const plugin = sveltePlugin();
    const result = plugin.apply(svelteSource, typeInfo, {
      filename: "comp.svelte",
    });
    expect(result).toContain("function foo(a: string) {}");
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
