import ts from "typescript";

import type { CollectedTypeInfo, ExtraOptions } from "./type-collector.js";

import { parseObjectType } from "./type-merge.js";

export type VerifyVerdict = "match" | "mismatch" | "unverifiable" | "no-declaration";

type VerifyOutcome = { verdict: VerifyVerdict; reason?: string };

export interface VerifyEntry {
  file: string;
  pos: number;
  declared: string | null;
  observed: string[];
  verdict: VerifyVerdict;
  reason?: string;
  opts: ExtraOptions;
}

export interface VerifyReport {
  entries: VerifyEntry[];
  totals: {
    total: number;
    match: number;
    mismatch: number;
    unverifiable: number;
    noDeclaration: number;
  };
}

/**
 * Compare runtime-observed types against the source's declared types.
 *
 * Reuses the same `CollectedTypeInfo` produced by the regular instrument →
 * collect pipeline; only the comparison step is new. Honest-by-design: returns
 * `unverifiable` rather than guessing whenever the declared type is more
 * expressive than the heuristic can analyse (generics, structural object
 * types, function types, etc.).
 */
export function verifyTypes(typeInfo: CollectedTypeInfo, program: ts.Program): VerifyReport {
  const checker = program.getTypeChecker();
  const entries: VerifyEntry[] = [];
  const totals = {
    total: typeInfo.length,
    match: 0,
    mismatch: 0,
    unverifiable: 0,
    noDeclaration: 0,
  };

  for (const [file, pos, observedTuples, opts] of typeInfo) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) {
      entries.push({
        file,
        pos,
        declared: null,
        observed: [],
        verdict: "no-declaration",
        reason: "source file not in program",
        opts,
      });
      totals.noDeclaration++;
      continue;
    }

    // Two declaration shapes to look for:
    // 1. Parameter / variable / property declarations — `pos` is at name.getEnd()
    // 2. Function-like return positions — `pos` is right after the closing
    //    `)` of the parameter list (where `: ReturnType` would be inserted).
    //    These come from `__tscptr__.ret(...)` calls that ts-capture emits with
    //    `opts.returnType: true`.
    const declNode = opts?.returnType
      ? findFunctionByReturnPos(sourceFile, pos)
      : findDeclarationByPos(sourceFile, pos);

    if (!declNode) {
      entries.push({
        file,
        pos,
        declared: null,
        observed: [],
        verdict: "no-declaration",
        reason: "no declaration at position",
        opts,
      });
      totals.noDeclaration++;
      continue;
    }

    const declared = resolveDeclaredType(declNode, checker);
    const observed = observedTuples.map(([t]) => t).filter((t): t is string => Boolean(t));
    const { verdict, reason } = isCompatible(observed, declared);

    entries.push({ file, pos, declared, observed, verdict, reason, opts });
    totals[verdict === "match" ? "match" : verdict === "mismatch" ? "mismatch" : "unverifiable"]++;
  }

  return { entries, totals };
}

/**
 * Resolve the declared type for a node, preferring explicit annotations over
 * inferred types. For function-like nodes the return type is what we want;
 * for everything else it's the value type.
 */
function resolveDeclaredType(node: ts.Node, checker: ts.TypeChecker): string {
  if (isFunctionLike(node)) {
    if (node.type) {
      return checker.typeToString(checker.getTypeFromTypeNode(node.type));
    }
    const sig = checker.getSignatureFromDeclaration(node);
    return sig ? checker.typeToString(sig.getReturnType()) : "unknown";
  }
  const explicitType = (node as ts.HasType).type;
  if (explicitType) {
    return checker.typeToString(checker.getTypeFromTypeNode(explicitType));
  }
  return checker.typeToString(checker.getTypeAtLocation(node));
}

/**
 * Find the parameter / variable / property declaration whose name ends at the
 * given offset. ts-capture's instrumenter records observations at `name.getEnd()`,
 * which is exactly where a `: Type` annotation would be inserted, so this
 * matches the position the runtime data was tagged with.
 */
function findDeclarationByPos(sourceFile: ts.SourceFile, pos: number): ts.Declaration | null {
  let found: ts.Declaration | null = null;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      (node.name.getEnd() === pos || node.name.getEnd() + 1 === pos) /* optional `?` */
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Find the function-like node whose return-type annotation position matches
 * `pos`. ts-capture's transformer computes return positions as the offset right
 * after the closing `)` of the parameter list — see transformer.ts line ~120
 * (the `parameters.end` + scan-to-')'+1 pattern). We mirror that calculation
 * so we recognise the same positions.
 */
function findFunctionByReturnPos(sourceFile: ts.SourceFile, pos: number): FunctionLike | null {
  const text = sourceFile.text;
  let found: FunctionLike | null = null;
  function visit(node: ts.Node) {
    if (found) return;
    if (isFunctionLike(node)) {
      let p = node.parameters.end;
      while (p < text.length && text[p] !== ")") p++;
      const returnPos = p + 1;
      if (returnPos === pos) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/**
 * Heuristic compatibility check between observed runtime type-names and the
 * declared TS type. Handles primitives, simple unions, `T | undefined`
 * optionals, and homogeneous arrays. Returns `unverifiable` for anything
 * involving generics, structural object types, or function types — these need
 * a real subtype check that the ts-capture core does not currently expose.
 */
export function isCompatible(observed: string[], declared: string): VerifyOutcome {
  if (observed.length === 0) return { verdict: "unverifiable", reason: "no observations" };

  const declaredNorm = normalize(declared);

  // Anything declared as `any` cannot be invalidated by observations.
  if (declaredNorm === "any") return { verdict: "unverifiable", reason: "declared any" };

  // unknown is similarly compatible with anything.
  if (declaredNorm === "unknown") return { verdict: "unverifiable", reason: "declared unknown" };

  // Function types: declared `(args) => ret` (possibly with generics prefix).
  // Observed values from getTypeName for functions look like
  // `(arg0: unknown, ...) => unknown`. We can't compare param/return types
  // deeply (observed is always `unknown` there), but we CAN tell whether
  // observed is a function at all — a non-function observation against a
  // function-typed declaration is a real mismatch.
  if (isFunctionType(declaredNorm)) {
    const allFns = observed.every((o) => isFunctionType(normalize(o)));
    if (allFns) return { verdict: "match" };
    return { verdict: "mismatch" };
  }

  // Structural object types: `{ a: T, b?: U }`.
  // Parse both declared and each observation as a key→type map; require all
  // non-optional declared keys to be present in observation, and recursively
  // verify the shared keys' value types.
  if (declaredNorm.startsWith("{") && declaredNorm.endsWith("}")) {
    return structuralCompat(declaredNorm, observed);
  }

  // Exact-equality fallback for generic types (`Set<string>`, `Map<K, V>`,
  // `Promise<T>`, …) BEFORE we bail. getTypeName produces these same strings
  // for matching runtime values, so character-for-character equality is a
  // legitimate (if conservative) match signal — `Set<string>` declared and
  // `Set<string>` observed should not get filed as unverifiable just because
  // we can't reason about the type-parameter relation.
  if (isComplex(declaredNorm)) {
    const allEqual = observed.every((o) => normalize(o) === declaredNorm);
    if (allEqual) return { verdict: "match" };
    return { verdict: "unverifiable", reason: "complex declared type" };
  }

  const declaredVariants = parseUnion(declaredNorm).map(normalize);

  for (const obs of observed) {
    if (obs == null) continue;
    if (!observedFits(normalize(obs), declaredVariants)) {
      return { verdict: "mismatch" };
    }
  }
  return { verdict: "match" };
}

function normalize(t: string): string {
  return t.trim().replace(/\s+/g, " ");
}

function isComplex(t: string): boolean {
  // Anything with <, {, ( indicates generics, structural types, or function
  // types — beyond MVP heuristic scope.
  return /[<{(]/.test(t);
}

/**
 * Detect a function-type signature like `(args) => ret` or
 * `<T>(args) => ret`. Heuristic: the signature contains a top-level `=>`
 * preceded by a parenthesised parameter list. Optional leading
 * `<T, U>` generics block is allowed.
 */
function isFunctionType(t: string): boolean {
  // Strip leading generics block if present
  const noGenerics = stripLeadingGenerics(t);
  return /^\(.*\)\s*=>/.test(noGenerics);
}

/**
 * Structural compatibility for `{ k: T, ... }` types. Each observation must:
 *   - itself be parseable as an object type
 *   - contain every non-optional declared key
 *   - match the value type for every shared key (recursively via isCompatible)
 * Index signatures (`[k: string]: T`) and complex constructs in declared keys
 * gracefully degrade to `unverifiable`.
 */
function structuralCompat(declared: string, observed: string[]): VerifyOutcome {
  const declaredMap = parseObjectType(declared);
  if (!declaredMap)
    return { verdict: "unverifiable", reason: "could not parse structural declared type" };

  // Index signatures or other unparseable shapes — bail.
  if ([...declaredMap.keys()].some((k) => k.startsWith("[") || k.startsWith("readonly ["))) {
    return { verdict: "unverifiable", reason: "index signature in declared type" };
  }

  for (const obs of observed) {
    const observedNorm = normalize(obs);
    if (!observedNorm.startsWith("{") || !observedNorm.endsWith("}")) {
      return { verdict: "mismatch" };
    }
    const observedMap = parseObjectType(observedNorm);
    if (!observedMap)
      return { verdict: "unverifiable", reason: "could not parse structural observed type" };

    for (const [rawKey, declaredValueType] of declaredMap) {
      const { key, optional } = parseKey(rawKey);
      const obsValue = observedMap.get(key) ?? observedMap.get(`readonly ${key}`);
      if (obsValue === undefined) {
        if (optional) continue;
        return { verdict: "mismatch" };
      }
      // Recurse — verify this single field. If recursion bails as
      // unverifiable, accept the field (we have no negative evidence).
      const inner = isCompatible([obsValue], stripFieldModifiers(declaredValueType));
      if (inner.verdict === "mismatch") return { verdict: "mismatch" };
    }
  }

  return { verdict: "match" };
}

function parseKey(rawKey: string): { key: string; optional: boolean } {
  let k = rawKey.trim();
  if (k.startsWith("readonly ")) k = k.slice("readonly ".length).trim();
  const optional = k.endsWith("?");
  if (optional) k = k.slice(0, -1).trim();
  return { key: k, optional };
}

function stripFieldModifiers(t: string): string {
  return t.trim().replace(/^readonly\s+/, "");
}

function stripLeadingGenerics(t: string): string {
  if (!t.startsWith("<")) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "<") depth++;
    else if (t[i] === ">") {
      depth--;
      if (depth === 0) return t.slice(i + 1).trimStart();
    }
  }
  return t;
}

function parseUnion(t: string): string[] {
  // After the isComplex bail, the remaining types are plain identifier-or-
  // identifier[] tokens, so a top-level pipe split is safe.
  return t
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function observedFits(observed: string, declaredVariants: string[]): boolean {
  // Bail on observed types that are themselves complex — they came from
  // getTypeName which can produce structural strings.
  if (isComplex(observed)) {
    // Fall back to substring match — better than nothing for `Array<T>` etc.
    return declaredVariants.some((v) => v === observed);
  }

  if (declaredVariants.includes(observed)) return true;

  // Homogeneous array compatibility: observed `T[]` matches declared `T[]`.
  if (observed.endsWith("[]")) {
    const elem = observed.slice(0, -2).trim();
    return declaredVariants.some(
      (v) => v.endsWith("[]") && observedFits(elem, [v.slice(0, -2).trim()]),
    );
  }

  return false;
}
