/**
 * PROTOTYPE — kept as a documented negative result.
 *
 * Hypothesis: `ts.TypeChecker` could
 * subsume `type-ir.ts`'s parser + lub + isSubtype, because the
 * compiler already knows TS's subtype lattice and structural
 * rules. If we inject each observation as
 * `declare const __obs_N: <type>;`, ask the checker for the
 * union, and serialise it back, we'd get an apply pipeline with
 * less hand-rolled type code.
 *
 * **Outcome of the prototype**: hypothesis partially falsified.
 * The checker handles three of the four operations we hoped for:
 *
 *   - Parsing type strings to structured types: YES via synth
 *     declarations.
 *   - Type-identity dedup in unions: YES (`string | string` →
 *     `string`).
 *   - Resolving lib types (Promise, Array, Map, Date, RegExp): YES.
 *   - Anti-unification / structural merging: **NO**. The
 *     checker's union builder (via the `|` type expression) does
 *     not collapse subsumed members or merge shared-key object
 *     shapes. See merge-via-checker.spec.ts for the documented
 *     cases:
 *
 *         `{ a: number, b: string } | { a: number }`
 *           → kept as flat union, not merged to `{ a: number, b?: string }`
 *
 *         `{ src: string } | { src: undefined }`
 *           → kept as flat union, not merged to `{ src: string | undefined }`
 *
 *         `string[] | unknown[]`
 *           → kept as flat union, even though `string[] ⊆ unknown[]`
 *
 * That's the work the `lub` + `isSubtype` actually does, and
 * what `mergeObjectTypes` in type-merge.ts did before it. The
 * checker's `|`-union BUILDER is a type-checking construct, not an
 * anti-unification engine — it will not do the merging for us.
 *
 * **Decision**: keep `type-ir.ts` and `mergeObjectTypes`. This
 * file stays in tree as the canonical evidence for the negative
 * result and as scaffolding for any future attempt that finds a
 * different angle.
 *
 * **Refinement (2026-06-02)**: the negative result above is scoped
 * to the strategy this prototype tested — delegating the merge to
 * the `|`-union builder and serialising via `typeToString`. It does
 * NOT mean "the checker can't help." A de-risk spike against the
 * real `type-ir.lub` reference established two untested angles that
 * ARE viable:
 *
 *   - `checker.isTypeAssignableTo` answers the subsumption question
 *     the union builder refuses to act on (e.g.
 *     `string[] ⊆ Array<boolean | string>` → true), so WE can drive
 *     the reduction the builder won't.
 *   - The fragile part of the type-ir stack is `parseType`
 *     (~554-LOC `type-ir-parser.ts`), not the merge. Using the
 *     checker as a robust PARSER (walk
 *     `getTypeAtLocation` into a `TypeNode`) is public-API-only and
 *     keeps `lub` + `serializeType` unchanged.
 *
 * `typeToString` still cannot be the serialiser (it matched the
 * `type-ir` format on only 4/14 cases). The implementation therefore
 * distinguishes FREE, POLICY, and SERIALIZE-GAP outcomes.
 */

import { randomUUID } from "node:crypto";
import ts from "typescript";

const SYNTH_PATH = "/__ts-capture_merge_probe.ts";

/**
 * **PROTOTYPE — DO NOT USE IN HOT PATH.**
 *
 * Negative-result prototype. Documented decision: keep
 * `type-ir.ts` and `mergeObjectTypes`. This export remains in tree
 * as evidence and scaffolding for any future revisit. It is NOT a
 * drop-in replacement for `mergeTypes` despite the similar shape:
 *
 *   - The checker doesn't anti-unify shared-key objects or subsume
 *     `string[] | Array<...>` style unions — those are what
 *     `mergeObjectTypes` + `irDedupUnion` are for.
 *   - Each call constructs a full `ts.createProgram` (parses
 *     lib.d.ts, builds a fresh checker). ~50-200ms per call on a
 *     modest machine. A hot-path use across thousands of merge
 *     calls would be fatal.
 *
 * See the issue body and `merge-via-checker.spec.ts` for the
 * documented cases.
 *
 * Returns a `string[]` matching the legacy `mergeTypes` contract:
 * each element is one union member. Returns null when the checker
 * can't safely process the inputs.
 *
 * @internal
 */
export function _prototypeMergeViaChecker(types: readonly string[]): string[] | null {
  if (types.length === 0) return [];
  if (types.length === 1) return [...types];

  // Synth identifiers prefixed with a per-call UUID so an observation
  // referencing `__obs_0` or `__merged` (legal TS —) can't
  // accidentally bind to our scaffolding. The TS2304 filter doesn't
  // catch that case because resolution would succeed against our own
  // declarations.
  const id = randomUUID().replace(/-/g, "");
  const obs = (i: number) => `__tscobs_${id}_${i}`;
  const merged = `__tscmerged_${id}`;

  // Declare each observation, then a final `merged` whose type is the
  // union of all of them. Asking the checker for `merged`'s type yields
  // the normalised union without needing access to the internal
  // `getUnionType` API.
  const obsDecls = types.map((t, i) => `declare const ${obs(i)}: ${t};`).join("\n");
  const mergedDecl = `declare const ${merged}: ${types
    .map((_, i) => `(typeof ${obs(i)})`)
    .join(" | ")};`;
  const declSource = `${obsDecls}\n${mergedDecl}\n`;

  // Permissive compiler options. We only need union + serialise.
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };

  const host = createSynthHost(declSource, compilerOptions);
  const program = ts.createProgram({
    rootNames: [SYNTH_PATH],
    options: compilerOptions,
    host,
  });

  const synth = program.getSourceFile(SYNTH_PATH);
  if (!synth) return null;

  // Refuse on syntactic errors — input wasn't a valid TS type string.
  const syntactic = program.getSyntacticDiagnostics(synth);
  if (syntactic.length > 0) return null;

  // Conservative: ANY semantic diagnostic disqualifies the input.
  // The previous filter listed only TS2304/2503 explicitly, but other
  // resolution failures (TS2314 generic-type-needs-args, TS2693
  // type-as-value, TS2456 circular alias, TS2552 typo suggestion)
  // would have produced a degraded type that flowed silently into the
  // output. Fall back to legacy on anything the checker flagged.
  const semantic = program.getSemanticDiagnostics(synth);
  if (semantic.length > 0) return null;

  const checker = program.getTypeChecker();
  let mergedDeclNode: ts.VariableDeclaration | null = null;
  for (const stmt of synth.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const decl = stmt.declarationList.declarations[0];
    if (!decl) continue;
    if (ts.isIdentifier(decl.name) && decl.name.text === merged) {
      mergedDeclNode = decl;
    }
  }
  if (!mergedDeclNode) return null;

  const unionType = checker.getTypeAtLocation(mergedDeclNode);
  const mergedText = checker.typeToString(
    unionType,
    /*enclosing*/ undefined,
    // NoTruncation: never elide; the default truncates at ~100 chars
    // which would silently drop large object shapes.
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
  );

  // Split into separate union members so the caller pipeline
  // (`Array.from(new Set(...)).sort().join(" | ")`) operates on
  // member-level granularity. Previous version returned `[joined]`,
  // which collapsed downstream dedup/sort/filter into no-ops.
  return splitTopLevelUnion(mergedText);
}

/**
 * Split a `|`-separated union string into its top-level members,
 * respecting bracket nesting. `"A | (B | C)"` → `["A", "(B | C)"]`.
 * `"{ a: number; b: string; } | { a: number; }"` → both shapes.
 *
 * Pipes inside `()`, `[]`, `{}`, or `<>` brackets are treated as
 * nested operator usage, not member separators.
 */
function splitTopLevelUnion(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === inQuote && s[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inQuote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (c === "|" && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail !== "") out.push(tail);
  return out;
}

/**
 * Minimal in-memory CompilerHost. Serves the synthetic source from
 * the in-memory string and forwards everything else to the standard
 * Node-based file readers (so lib.d.ts resolves through `typescript`'s
 * built-in lookup).
 */
function createSynthHost(declSource: string, options: ts.CompilerOptions): ts.CompilerHost {
  const synthSourceFile = ts.createSourceFile(
    SYNTH_PATH,
    declSource,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const defaultHost = ts.createCompilerHost(options, /*setParentNodes*/ true);
  return {
    ...defaultHost,
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (fileName === SYNTH_PATH) return synthSourceFile;
      return defaultHost.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    fileExists: (fileName) => {
      if (fileName === SYNTH_PATH) return true;
      return defaultHost.fileExists(fileName);
    },
    readFile: (fileName) => {
      if (fileName === SYNTH_PATH) return declSource;
      return defaultHost.readFile(fileName);
    },
    writeFile: () => {
      // No emit — we only want diagnostics + type info.
    },
  };
}
