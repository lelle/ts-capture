import { afterEach, describe, expect, it, vi } from "vitest";

import { instrumented } from "./test-utils/instrumented.js";
import "./test-utils/matchers.js";

const BARE = { skipTscptrDeclarations: true };

describe("instrument", () => {
  describe("TS_CAPTURE_OBSERVE_ANNOTATED", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each(["1", "true"])("observes typed parameters when set to %s", (value) => {
      vi.stubEnv("TS_CAPTURE_OBSERVE_ANNOTATED", value);
      const out = instrumented("function foo(a: string) { return a; }", { options: BARE });
      expect(out).toTrack("a", { annotated: true });
    });

    it("leaves typed parameters untracked when unset", () => {
      vi.stubEnv("TS_CAPTURE_OBSERVE_ANNOTATED", "");
      const out = instrumented("function foo(a: string) { return a; }", { options: BARE });
      expect(out).toLeaveUntracked("a");
    });
  });

  it("instruments a function with unannotated parameter", () => {
    const out = instrumented("function foo(a) { return a; }");
    expect(out).toTrack("a", { in: "test.ts" });
  });

  it("includes __tscptr__ declarations by default", () => {
    const out = instrumented("function foo(a) { return a; }");
    expect(out).toDeclareRuntime();
  });

  it("skips declarations when skipTscptrDeclarations is true", () => {
    const out = instrumented("const x = 1;", { options: { skipTscptrDeclarations: true } });
    expect(out).not.toDeclareRuntime();
  });

  it("does not instrument already-typed parameters", () => {
    const out = instrumented("function foo(a: string) { return a; }", { options: BARE });
    expect(out).toLeaveUntracked("a");
  });

  it("does not instrument parameters with default values", () => {
    const out = instrumented("function foo(a = 12) { return a; }", { options: BARE });
    expect(out).toLeaveUntracked("a");
  });

  it("instruments call expressions when enabled", () => {
    const out = instrumented("foo(bar)", {
      options: { ...BARE, instrumentCallExpressions: true },
    });
    expect(out).toTrackArgument("bar");
  });

  it("does not instrument call expressions by default", () => {
    const out = instrumented("foo(bar)", { options: BARE });
    expect(out).not.toTrackArgument("bar");
  });

  it("preserves the filename in instrumented output", () => {
    const out = instrumented("function f(x) { return x; }", {
      filename: "src/my-file.ts",
      options: BARE,
    });
    expect(out).toTrack("x", { in: "src/my-file.ts" });
  });

  it("returns valid TypeScript source", () => {
    const input = `
      class Greeter {
        greet(who) {
          return 'Hello, ' + who;
        }
      }
    `;
    // instrumented() itself rejects an output that does not parse, or that is
    // anything but the input with calls added.
    const out = instrumented(input);
    expect(out).toTrack("who");
    expect(out).toWrapReturnOf("greet");
  });

  it("does not emit identifiers starting with $ (reserved by Svelte 5 runes)", () => {
    // Svelte 5 reserves the $ prefix for runes, so a .svelte <script lang="ts">
    // block only compiles after instrumentation if nothing added starts with
    // one. The spelling is the claim here, so this one reads the text.
    const out = instrumented("function foo(a) { return a; }");
    expect(out.text).not.toMatch(/\$\w+/);
  });

  // skipInitializerCalleeWhen lets a framework adapter keep a call as the
  // direct right-hand side of its declaration: Svelte 5 rejects a rune that
  // is wrapped. Core provides the mechanism, the adapter the policy.
  describe("skipInitializerCalleeWhen (framework-neutral skip hook)", () => {
    it("skips wrapping when predicate returns true (varDecl)", () => {
      const out = instrumented("let x = myFn(1);", {
        options: { ...BARE, skipInitializerCalleeWhen: (name) => name === "myFn" },
      });
      expect(out).not.toWrapInitializerOf("x");
    });

    it("walks property-access chains to the root identifier", () => {
      const out = instrumented("let x = ns.fn.member(1);", {
        options: { ...BARE, skipInitializerCalleeWhen: (name) => name === "ns" },
      });
      expect(out).toLeaveUnchanged();
    });

    it("skips class field initializers when predicate matches", () => {
      const out = instrumented("class C { x = mark(0); }", {
        options: { ...BARE, skipInitializerCalleeWhen: (name) => name === "mark" },
      });
      expect(out).not.toWrapInitializerOf("x");
    });

    it("default behavior (no predicate) wraps every initializer", () => {
      const out = instrumented("let x = myFn(1);", { options: BARE });
      expect(out).toWrapInitializerOf("x");
    });

    it("predicate returning false does not affect wrapping", () => {
      const out = instrumented("let x = myFn(1);", {
        options: { ...BARE, skipInitializerCalleeWhen: () => false },
      });
      expect(out).toWrapInitializerOf("x");
    });
  });
});
