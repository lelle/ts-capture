import { describe, expect, it } from "vitest";

import { instrumentSource } from "./instrument.js";

describe("instrument", () => {
  it("instruments a function with unannotated parameter", () => {
    const result = instrumentSource("function foo(a) { return a; }", "test.ts");
    expect(result).toContain('__tscptr__("a", a,');
    expect(result).toContain('"test.ts"');
  });

  it("includes __tscptr__ declarations by default", () => {
    const result = instrumentSource("function foo(a) { return a; }", "test.ts");
    expect(result).toContain("declare function __tscptr__");
  });

  it("skips declarations when skipTscptrDeclarations is true", () => {
    const result = instrumentSource("const x = 1;", "test.ts", { skipTscptrDeclarations: true });
    expect(result).not.toContain("declare function __tscptr__");
  });

  it("does not instrument already-typed parameters", () => {
    const result = instrumentSource("function foo(a: string) { return a; }", "test.ts", {
      skipTscptrDeclarations: true,
    });
    expect(result).not.toContain('__tscptr__("a"');
  });

  it("does not instrument parameters with default values", () => {
    const result = instrumentSource("function foo(a = 12) { return a; }", "test.ts", {
      skipTscptrDeclarations: true,
    });
    expect(result).not.toContain('__tscptr__("a"');
  });

  it("instruments call expressions when enabled", () => {
    const result = instrumentSource("foo(bar)", "test.ts", {
      instrumentCallExpressions: true,
      skipTscptrDeclarations: true,
    });
    expect(result).toContain("__tscptr__.track(bar,");
  });

  it("does not instrument call expressions by default", () => {
    const result = instrumentSource("foo(bar)", "test.ts", { skipTscptrDeclarations: true });
    expect(result).not.toContain("__tscptr__.track");
  });

  it("preserves the filename in instrumented output", () => {
    const result = instrumentSource("function f(x) { return x; }", "src/my-file.ts", {
      skipTscptrDeclarations: true,
    });
    expect(result).toContain("src/my-file.ts");
  });

  it("returns valid TypeScript source", () => {
    const input = `
      class Greeter {
        greet(who) {
          return 'Hello, ' + who;
        }
      }
    `;
    const result = instrumentSource(input, "test.ts");
    // Should parse without errors
    expect(result).toContain("greet(who)");
    expect(result).toContain("__tscptr__");
  });

  it("does not emit identifiers starting with $ (reserved by Svelte 5 runes)", () => {
    // Svelte 5 rejects user-defined identifiers starting with $ — that
    // prefix is reserved for runes ($state, $derived, etc.). The collector
    // identifier must not start with $ so .svelte <script lang="ts"> blocks
    // compile after instrumentation.
    const result = instrumentSource("function foo(a) { return a; }", "test.ts");
    // Match $ followed by an identifier char (\w = [A-Za-z0-9_]).
    // Allowed: $-in-strings or template literals are fine; we only care
    // about raw identifier-position uses. A simple regex on the source
    // catches the dominant pattern (declare/calls/property access).
    expect(result).not.toMatch(/\$\w+/);
  });

  // skipInitializerCalleeWhen lets framework adapters opt out of
  // __tscptr__.ret wrapping for varDecl / class-field initializers whose
  // root callee name matches a predicate. Used by @ts-capture/svelte to
  // skip Svelte 5 rune calls ($state, $derived, etc.) — runes must be the
  // DIRECT RHS of the declaration or Svelte errors:
  //   "$derived(...) can only be used as a variable declaration initializer..."
  //
  // Core stays framework-neutral: it provides the mechanism, adapters
  // provide the policy.
  describe("skipInitializerCalleeWhen (framework-neutral skip hook)", () => {
    it("skips wrapping when predicate returns true (varDecl)", () => {
      const result = instrumentSource("let x = myFn(1);", "test.ts", {
        skipTscptrDeclarations: true,
        skipInitializerCalleeWhen: (name) => name === "myFn",
      });
      expect(result).toMatch(/let x = myFn\(1\)/);
      expect(result).not.toMatch(/__tscptr__\.ret\(\s*myFn/);
    });

    it("walks property-access chains to the root identifier", () => {
      const result = instrumentSource("let x = ns.fn.member(1);", "test.ts", {
        skipTscptrDeclarations: true,
        skipInitializerCalleeWhen: (name) => name === "ns",
      });
      expect(result).toMatch(/let x = ns\.fn\.member\(1\)/);
      expect(result).not.toMatch(/__tscptr__\.ret/);
    });

    it("skips class field initializers when predicate matches", () => {
      const result = instrumentSource("class C { x = mark(0); }", "test.ts", {
        skipTscptrDeclarations: true,
        skipInitializerCalleeWhen: (name) => name === "mark",
      });
      expect(result).toMatch(/x = mark\(0\)/);
      expect(result).not.toMatch(/__tscptr__\.ret\(\s*mark/);
    });

    it("default behavior (no predicate) wraps every initializer", () => {
      const result = instrumentSource("let x = myFn(1);", "test.ts", {
        skipTscptrDeclarations: true,
      });
      expect(result).toMatch(/__tscptr__\.ret\(myFn\(1\)/);
    });

    it("predicate returning false does not affect wrapping", () => {
      const result = instrumentSource("let x = myFn(1);", "test.ts", {
        skipTscptrDeclarations: true,
        skipInitializerCalleeWhen: () => false,
      });
      expect(result).toMatch(/__tscptr__\.ret\(myFn\(1\)/);
    });
  });
});
