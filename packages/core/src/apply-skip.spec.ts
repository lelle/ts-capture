import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildSkipMatcher, DEFAULT_TEST_FILE_RE } from "./apply-skip.js";

const BASE = path.resolve("/project");
const f = (rel: string) => path.join(BASE, rel);

describe("DEFAULT_TEST_FILE_RE", () => {
  it("matches common test/spec extensions at any depth", () => {
    for (const name of [
      "math.spec.ts",
      "Component.test.tsx",
      "util.spec.mts",
      "old.test.cjs",
      "legacy.test.js",
    ]) {
      expect(DEFAULT_TEST_FILE_RE.test(name)).toBe(true);
    }
  });

  it("does not match non-test files that merely contain 'spec'/'test'", () => {
    for (const name of ["inspector.ts", "fastest.ts", "respec.tsx"]) {
      expect(DEFAULT_TEST_FILE_RE.test(name)).toBe(false);
    }
  });
});

describe("buildSkipMatcher — built-in test default", () => {
  it("skips test files by default", () => {
    const m = buildSkipMatcher(undefined, { includeTests: false, baseDir: BASE });
    expect(m.shouldSkip(f("src/math.spec.ts"))).toBe(true);
    expect(m.shouldSkip(f("src/math.ts"))).toBe(false);
  });

  it("includeTests drops the built-in test default", () => {
    const m = buildSkipMatcher(undefined, { includeTests: true, baseDir: BASE });
    expect(m.shouldSkip(f("src/math.spec.ts"))).toBe(false);
  });
});

describe("buildSkipMatcher — user globs (gitignore-style, additive)", () => {
  it("stacks user globs on top of the built-in test default", () => {
    const m = buildSkipMatcher(["src/generated/**"], {
      includeTests: false,
      baseDir: BASE,
    });
    // built-in default still active
    expect(m.shouldSkip(f("a/b.spec.ts"))).toBe(true);
    // user glob, anchored (contains a slash)
    expect(m.shouldSkip(f("src/generated/api.ts"))).toBe(true);
    expect(m.shouldSkip(f("src/generated/nested/deep.ts"))).toBe(true);
    expect(m.shouldSkip(f("src/handwritten.ts"))).toBe(false);
  });

  it("a slash-less glob matches the basename at any depth", () => {
    const m = buildSkipMatcher(["*.helper.ts"], {
      includeTests: false,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("x.helper.ts"))).toBe(true);
    expect(m.shouldSkip(f("deeply/nested/y.helper.ts"))).toBe(true);
    expect(m.shouldSkip(f("x.ts"))).toBe(false);
  });

  it("an anchored glob does NOT match the same name at other depths", () => {
    const m = buildSkipMatcher(["src/*.gen.ts"], {
      includeTests: false,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("src/a.gen.ts"))).toBe(true);
    expect(m.shouldSkip(f("src/sub/a.gen.ts"))).toBe(false);
  });

  it("** crosses path separators; * does not", () => {
    const m = buildSkipMatcher(["src/**/index.ts", "lib/*.ts"], {
      includeTests: false,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("src/index.ts"))).toBe(true);
    expect(m.shouldSkip(f("src/a/b/index.ts"))).toBe(true);
    expect(m.shouldSkip(f("lib/a.ts"))).toBe(true);
    expect(m.shouldSkip(f("lib/a/b.ts"))).toBe(false);
  });
});

describe("buildSkipMatcher — negation (last-match-wins)", () => {
  it("a leading ! re-includes a file the built-in default would skip", () => {
    const m = buildSkipMatcher(["!keep.spec.ts"], {
      includeTests: false,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("keep.spec.ts"))).toBe(false);
    expect(m.shouldSkip(f("other.spec.ts"))).toBe(true);
  });

  it("a later negation overrides an earlier positive user glob", () => {
    const m = buildSkipMatcher(["src/generated/**", "!src/generated/keep.ts"], {
      includeTests: false,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("src/generated/api.ts"))).toBe(true);
    expect(m.shouldSkip(f("src/generated/keep.ts"))).toBe(false);
  });

  it("a later positive overrides an earlier negation (order matters)", () => {
    const m = buildSkipMatcher(["!*.spec.ts", "secret.spec.ts"], {
      includeTests: false,
      baseDir: BASE,
    });
    // default skips *.spec.ts; first user pattern re-includes all; second re-skips one
    expect(m.shouldSkip(f("a.spec.ts"))).toBe(false);
    expect(m.shouldSkip(f("secret.spec.ts"))).toBe(true);
  });
});

describe("buildSkipMatcher — brace expansion", () => {
  it("expands a top-level comma group into alternatives", () => {
    const m = buildSkipMatcher(["**/*.{spec,test}.ts"], {
      includeTests: true, // isolate brace behavior from the default
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("a/b.spec.ts"))).toBe(true);
    expect(m.shouldSkip(f("a/b.test.ts"))).toBe(true);
    expect(m.shouldSkip(f("a/b.unit.ts"))).toBe(false);
  });

  it("expands multiple groups in one pattern (cartesian product)", () => {
    const m = buildSkipMatcher(["comp.{spec,test}.{ts,tsx}"], {
      includeTests: true,
      baseDir: BASE,
    });
    for (const name of ["comp.spec.ts", "comp.spec.tsx", "comp.test.ts", "comp.test.tsx"]) {
      expect(m.shouldSkip(f(name))).toBe(true);
    }
    expect(m.shouldSkip(f("comp.spec.js"))).toBe(false);
  });

  it("expands nested brace groups", () => {
    const m = buildSkipMatcher(["{a,{b,c}}.ts"], {
      includeTests: true,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("a.ts"))).toBe(true);
    expect(m.shouldSkip(f("deep/b.ts"))).toBe(true);
    expect(m.shouldSkip(f("deep/c.ts"))).toBe(true);
    expect(m.shouldSkip(f("d.ts"))).toBe(false);
  });

  it("computes anchoring per expanded variant when a branch contains a slash", () => {
    // `src/a.ts` is anchored (has a slash); `b.ts` is a slash-less
    // basename match at any depth.
    const m = buildSkipMatcher(["{src/a,b}.ts"], {
      includeTests: true,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("src/a.ts"))).toBe(true);
    expect(m.shouldSkip(f("sub/src/a.ts"))).toBe(false); // anchored variant
    expect(m.shouldSkip(f("nested/deep/b.ts"))).toBe(true); // basename variant
  });

  it("combines negation with brace expansion", () => {
    const m = buildSkipMatcher(["!keep.{spec,test}.ts"], {
      includeTests: false,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("keep.spec.ts"))).toBe(false);
    expect(m.shouldSkip(f("keep.test.ts"))).toBe(false);
    expect(m.shouldSkip(f("other.spec.ts"))).toBe(true);
  });

  it("treats a brace group with no top-level comma as a literal", () => {
    // Mirrors bash: `{a}` is not an alternation, it stays literal.
    const m = buildSkipMatcher(["file{x}.ts"], {
      includeTests: true,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("file{x}.ts"))).toBe(true);
    expect(m.shouldSkip(f("filex.ts"))).toBe(false);
  });
});

describe("buildSkipMatcher — edge cases", () => {
  it("ignores empty / whitespace-only patterns", () => {
    const m = buildSkipMatcher(["", "  ", "!"], {
      includeTests: false,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("a.spec.ts"))).toBe(true);
    expect(m.shouldSkip(f("a.ts"))).toBe(false);
  });

  it("escapes regex-special characters in literal globs", () => {
    const m = buildSkipMatcher(["src/a+b.ts"], {
      includeTests: false,
      baseDir: BASE,
    });
    expect(m.shouldSkip(f("src/a+b.ts"))).toBe(true);
    expect(m.shouldSkip(f("src/aaab.ts"))).toBe(false);
  });
});
