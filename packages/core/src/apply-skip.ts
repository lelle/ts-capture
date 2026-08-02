import path from "node:path";

// Default test-file glob — apply skips these unless --include-tests is set.
// Test/spec files get unwanted annotations like
// `it("...", (): Assertion => ...)` because they import and therefore
// observe the units they exercise. The annotations are rarely useful
// in tests and frequently cause TS errors against test runner types.
// Default-exclude common JS-ecosystem test patterns.
export const DEFAULT_TEST_FILE_RE = /\.(?:spec|test)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface CompiledPattern {
  re: RegExp;
  negated: boolean;
  // gitignore rule: a slash-less pattern matches the basename at any
  // depth; a pattern containing a slash is anchored to the config dir.
  matchBasename: boolean;
}

export interface SkipMatcher {
  /** True when `file` (absolute) should be skipped by apply. */
  shouldSkip(file: string): boolean;
}

/**
 * Build a gitignore-style skip matcher for `ts-capture apply`.
 *
 * The built-in test-file default ({@link DEFAULT_TEST_FILE_RE}) is the
 * implicit first entry of the chain (omitted when `includeTests` is on).
 * User `skipFiles` globs stack on top. Files are evaluated against every
 * pattern in order, **last match wins**, and a leading `!` negates
 * (re-includes). Mirrors git/eslint/prettier ignore semantics — see the
 * design discussion that chose this over the tsconfig/jest "replace"
 * model.
 *
 * Supported glob syntax (a deliberately small subset): `*` (any run of
 * non-separator chars), `**` (any chars including separators), `?` (one
 * non-separator char), comma-alternation brace groups (`{a,b}`, nested
 * allowed), and a leading `!`. Numeric ranges (`{1..3}`) are not
 * supported.
 */
export function buildSkipMatcher(
  userPatterns: readonly string[] | undefined,
  options: { includeTests: boolean; baseDir: string },
): SkipMatcher {
  const patterns: CompiledPattern[] = [];
  if (!options.includeTests) {
    patterns.push({ re: DEFAULT_TEST_FILE_RE, negated: false, matchBasename: true });
  }
  for (const raw of userPatterns ?? []) {
    patterns.push(...compilePatterns(raw));
  }

  const baseDir = options.baseDir;
  return {
    shouldSkip(file: string): boolean {
      const rel = toPosix(path.relative(baseDir, file));
      const base = rel.slice(rel.lastIndexOf("/") + 1);
      let skip = false;
      for (const p of patterns) {
        const target = p.matchBasename ? base : rel;
        if (p.re.test(target)) skip = !p.negated;
      }
      return skip;
    },
  };
}

function compilePatterns(pattern: string): CompiledPattern[] {
  let glob = pattern.trim();
  let negated = false;
  if (glob.startsWith("!")) {
    negated = true;
    glob = glob.slice(1);
  }
  if (glob === "") return [];
  // Brace-expand first so anchoring is decided per concrete variant — a
  // branch may add a slash (`{src/a,b}` → one anchored, one basename).
  return expandBraces(glob).flatMap((variant) => {
    if (variant === "") return [];
    const matchBasename = !variant.includes("/");
    // A leading slash anchors to the config dir, which is already what
    // relative-path matching does — strip it so the regex doesn't require
    // a leading separator.
    const body = variant.startsWith("/") ? variant.slice(1) : variant;
    return [{ re: globToRegExp(body), negated, matchBasename }];
  });
}

// Cap the cartesian product of brace groups so a pathological pattern
// (`{a,b}{a,b}{a,b}...`) can't blow up. Real ignore globs stay far below.
const MAX_BRACE_EXPANSION = 1024;

/**
 * Expand comma-alternation brace groups (`{a,b}`, nested allowed) into a
 * flat list of brace-free globs. Mirrors shell semantics: a `{...}` with
 * no top-level comma is left literal (`{a}` stays `{a}`); unbalanced
 * braces are left literal. Numeric/alpha ranges (`{1..3}`) are NOT
 * supported.
 */
function expandBraces(glob: string): string[] {
  const group = findBraceGroup(glob);
  if (!group) return [glob];
  const prefix = glob.slice(0, group.start);
  const suffix = glob.slice(group.end + 1);
  const out: string[] = [];
  for (const option of group.options) {
    for (const expanded of expandBraces(prefix + option + suffix)) {
      out.push(expanded);
      if (out.length >= MAX_BRACE_EXPANSION) return out;
    }
  }
  return out;
}

/**
 * Locate the first brace group that is a valid alternation: balanced and
 * containing at least one top-level comma. Brace groups without a
 * top-level comma are skipped (treated as literal text).
 */
function findBraceGroup(
  glob: string,
): { start: number; end: number; options: string[] } | undefined {
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] !== "{") continue;
    let depth = 0;
    let optStart = i + 1;
    let hasComma = false;
    const options: string[] = [];
    for (let j = i; j < glob.length; j++) {
      const c = glob[j];
      if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          options.push(glob.slice(optStart, j));
          if (hasComma) return { start: i, end: j, options };
          break; // no top-level comma — this `{` is literal, try the next one
        }
      } else if (c === "," && depth === 1) {
        options.push(glob.slice(optStart, j));
        optStart = j + 1;
        hasComma = true;
      }
    }
  }
  return undefined;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          // `**/` matches zero or more leading path segments.
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "/") {
      re += "/";
    } else if (/[\\^$.|+()[\]{}]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
