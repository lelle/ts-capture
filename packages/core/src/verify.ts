import ts from "typescript";

import type { CollectedTypeInfo, ExtraOptions } from "./type-collector.js";

import { findCloseParenPos } from "./instrumentation-site-spec.js";
import { unwrapOneLevelPromise } from "./named-type-rewrite.js";
import { parseObjectType } from "./type-merge.js";

export type VerifyVerdict = "match" | "mismatch" | "unverifiable" | "no-declaration";

type VerifyOutcome = { verdict: VerifyVerdict; reason?: string };

export interface VerifyEntry {
  file: string;
  pos: number;
  /** One-based, at the declaration name or the return-type position. Absent when the file is not in the program. */
  line?: number;
  column?: number;
  name?: string;
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
 * Compare runtime-observed types with the type TypeScript has at each observed
 * position: the written type where there is one, which is observed only with
 * `observeAnnotated`, and otherwise what TypeScript infers there.
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
        ...locate(sourceFile, pos),
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
    const { verdict, reason } =
      opts?.async && isFunctionLike(declNode)
        ? compareAwaited(observed, declNode, checker)
        : isCompatible(observed, declared);

    entries.push({
      file,
      pos,
      ...locate(sourceFile, isFunctionLike(declNode) ? pos : declNode.name.getStart(sourceFile)),
      name: isFunctionLike(declNode) ? "return type" : normalize(declNode.name.getText(sourceFile)),
      declared,
      observed,
      verdict,
      reason,
      opts,
    });
    totals[verdict === "match" ? "match" : verdict === "mismatch" ? "mismatch" : "unverifiable"]++;
  }

  return { entries, totals };
}

function locate(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

/**
 * Resolve the declared type for a node, preferring explicit annotations over
 * inferred types. For function-like nodes the return type is what we want;
 * for everything else it's the value type.
 */
function resolveDeclaredType(node: ts.Node, checker: ts.TypeChecker): string {
  if (isFunctionLike(node)) {
    const type = returnTypeOf(node, checker);
    return type ? checker.typeToString(type) : "unknown";
  }
  const explicitType = (node as ts.HasType).type;
  if (explicitType) {
    const written = checker.typeToString(checker.getTypeFromTypeNode(explicitType));
    // `x?: T` may be left out, which a call observes as `undefined`.
    const optional = ts.isParameter(node) && node.questionToken !== undefined;
    if (!optional || splitTopLevelUnion(written).includes("undefined")) return written;
    return isFunctionType(written) ? `(${written}) | undefined` : `${written} | undefined`;
  }
  return checker.typeToString(checker.getTypeAtLocation(node));
}

function returnTypeOf(node: FunctionLike, checker: ts.TypeChecker): ts.Type | undefined {
  if (node.type) return checker.getTypeFromTypeNode(node.type);
  return checker.getSignatureFromDeclaration(node)?.getReturnType();
}

// An async return is observed as what its promise resolved to, so it is
// compared with the awaited type; the report still shows the `Promise<T>`.
function compareAwaited(
  observed: string[],
  node: FunctionLike,
  checker: ts.TypeChecker,
): VerifyOutcome {
  if (observed.includes("Promise"))
    return { verdict: "unverifiable", reason: "promise not settled" };
  const type = returnTypeOf(node, checker);
  const awaited = type && checker.getAwaitedType(type);
  if (!awaited) return { verdict: "unverifiable", reason: "no awaited type" };
  return isCompatible(observed.map(unwrapOneLevelPromise), checker.typeToString(awaited));
}

/**
 * Find the parameter / variable / property declaration whose name ends at the
 * given offset. ts-capture's instrumenter records observations at `name.getEnd()`,
 * which is exactly where a `: Type` annotation would be inserted, so this
 * matches the position the runtime data was tagged with.
 */
type NamedDeclaration = (
  ts.ParameterDeclaration | ts.VariableDeclaration | ts.PropertyDeclaration
) & {
  name: ts.Identifier | ts.BindingPattern;
};

function findDeclarationByPos(sourceFile: ts.SourceFile, pos: number): NamedDeclaration | null {
  let found: NamedDeclaration | null = null;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      // A destructured parameter is observed whole, at the end of its pattern.
      (ts.isIdentifier(node.name) || ts.isParameter(node)) &&
      (node.name.getEnd() === pos || node.name.getEnd() + 1 === pos) /* optional `?` */
    ) {
      found = node as NamedDeclaration;
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
 * Find the function-like node whose return position is `pos`, computed the
 * way the instrumenter computes it (`findCloseParenPos`), paren-less arrows
 * included.
 */
function findFunctionByReturnPos(sourceFile: ts.SourceFile, pos: number): FunctionLike | null {
  let found: FunctionLike | null = null;
  function visit(node: ts.Node) {
    if (found) return;
    if (isFunctionLike(node) && findCloseParenPos(node, sourceFile) === pos) {
      found = node;
      return;
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

  // Anything declared as `any`, or as an array of it, cannot be invalidated by observations.
  if (/^any(?:\[\])*$/.test(declaredNorm))
    return { verdict: "unverifiable", reason: "declared any" };

  // unknown is similarly compatible with anything.
  if (declaredNorm === "unknown") return { verdict: "unverifiable", reason: "declared unknown" };

  // Polymorphic `this` is the receiver's class, which the observation names
  // but the declaration does not.
  if (declaredNorm === "this") return { verdict: "unverifiable", reason: "declared this" };

  // A union with a function, object or generic arm, `((e: Error) => void) |
  // undefined`: each observation is held against each arm on its own.
  const arms = splitTopLevelUnion(declaredNorm);
  if (arms.length > 1 && arms.some(isComplex)) return compareArms(observed, arms);

  // Function types: declared `(args) => ret` (possibly with generics prefix).
  // Observed values from getTypeName for functions look like
  // `(arg0: unknown, ...) => unknown`. We can't compare param/return types
  // deeply (observed is always `unknown` there), but we CAN tell whether
  // observed is a function at all — a non-function observation against a
  // function-typed declaration is a real mismatch.
  if (isFunctionType(declaredNorm)) {
    const allFns = observed.every((o) => isFunctionObservation(normalize(o)));
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

  const declaredVariants = parseUnion(declaredNorm)
    .map(normalize)
    .map((v) => v.replace(/^readonly /, ""));

  let unverifiable: VerifyOutcome | undefined;
  for (const obs of observed) {
    if (obs == null) continue;
    const observedNorm = normalize(obs);
    if (observedFits(observedNorm, declaredVariants)) continue;
    const reason = whyNoContradiction(observedNorm, declaredVariants);
    if (!reason) return { verdict: "mismatch" };
    unverifiable ??= { verdict: "unverifiable", reason };
  }
  return unverifiable ?? { verdict: "match" };
}

const PRIMITIVES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "null",
  "undefined",
  "void",
  "never",
  "object",
]);

const LITERAL_FAMILY: Array<[RegExp, string]> = [
  [/^(?:"[^"]*"|'[^']*')$/, "string"],
  [/^-?\d+n$/, "bigint"],
  [/^-?\d+(?:\.\d+)?$/, "number"],
  [/^(?:true|false)$/, "boolean"],
];

const literalFamily = (t: string): string | undefined =>
  LITERAL_FAMILY.find(([re]) => re.test(t))?.[1];

const isPrimitiveOrLiteral = (t: string): boolean =>
  PRIMITIVES.has(t) || literalFamily(t) !== undefined;

/** A primitive or a literal, or an array of one. */
const isPlain = (t: string): boolean => isPrimitiveOrLiteral(t.replace(/(?:\[\])+$/, ""));

// An observation outside every arm contradicts the written type only when the
// text says what every arm holds. A name may stand for any shape the run saw,
// and a literal arm is widened by the run (`"ws"` is observed as `string`).
function whyNoContradiction(observed: string, declaredVariants: string[]): string | undefined {
  if (declaredVariants.some((v) => !isPlain(v))) return "named declared type";
  if (declaredVariants.some((v) => literalFamily(v) === observed)) return "literal declared type";
  return undefined;
}

function compareArms(observed: string[], arms: string[]): VerifyOutcome {
  let unverifiable: VerifyOutcome | undefined;
  for (const obs of observed) {
    const outcomes = arms.map((arm) => isCompatible([obs], unparenthesize(arm)));
    if (outcomes.some((o) => o.verdict === "match")) continue;
    const unsure = outcomes.find((o) => o.verdict === "unverifiable");
    if (!unsure) return { verdict: "mismatch" };
    unverifiable ??= unsure;
  }
  return unverifiable ?? { verdict: "match" };
}

/** Split on the `|` that are not inside brackets, parentheses or a generic. */
function splitTopLevelUnion(t: string): string[] {
  const arms: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "}" || c === "]" || (c === ">" && t[i - 1] !== "=")) depth--;
    else if (c === "|" && depth === 0) {
      arms.push(t.slice(start, i).trim());
      start = i + 1;
    }
  }
  arms.push(t.slice(start).trim());
  return arms.filter((arm) => arm.length > 0);
}

function unparenthesize(t: string): string {
  if (!t.startsWith("(") || !t.endsWith(")")) return t;
  let depth = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    if (depth === 0) return t;
  }
  return t.slice(1, -1).trim();
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

  let unverifiable: VerifyOutcome | undefined;
  for (const obs of observed) {
    const observedNorm = normalize(obs);
    if (!observedNorm.startsWith("{") || !observedNorm.endsWith("}")) {
      if (isPrimitiveOrLiteral(observedNorm)) return { verdict: "mismatch" };
      // A class or an instance by name may well have the keys.
      unverifiable ??= { verdict: "unverifiable", reason: "named observed type" };
      continue;
    }
    const parsed = parseObjectType(observedNorm);
    if (!parsed)
      return { verdict: "unverifiable", reason: "could not parse structural observed type" };
    const observedMap = methodsAsProperties(parsed);

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

  return unverifiable ?? { verdict: "match" };
}

// An observed method, `f(x: T): U`, is a property holding `(x: T) => U`.
function methodsAsProperties(observed: Map<string, string>): Map<string, string> {
  const properties = new Map<string, string>();
  for (const [key, value] of observed) {
    const method = /^([\w$]+)\??\((.*)\)$/s.exec(key);
    if (method) properties.set(method[1], `(${method[2]}) => ${value}`);
    else properties.set(key, value);
  }
  return properties;
}

// A mock or a bound function is walked as an object with `apply` and `bind`;
// a class is observed as `typeof Name`.
function isFunctionObservation(observed: string): boolean {
  return (
    observed === "Function" ||
    observed.startsWith("typeof ") ||
    isFunctionType(observed) ||
    (observed.startsWith("{") && /\bapply\(/.test(observed) && /\bbind\(/.test(observed))
  );
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
  // An empty array is observed as `unknown[]`.
  if (observed === "unknown[]" && declaredVariants.some((v) => v.endsWith("[]"))) return true;
  if (declaredVariants.includes("object") && !isPrimitiveOrLiteral(observed)) return true;

  // Bail on observed types that are themselves complex — they came from
  // getTypeName which can produce structural strings.
  if (isComplex(observed)) {
    // Fall back to substring match — better than nothing for `Array<T>` etc.
    return declaredVariants.some((v) => v === observed);
  }

  if (declaredVariants.includes(observed)) return true;

  // A function without a return statement is inferred `void` and observed `undefined`.
  if (observed === "undefined" && declaredVariants.includes("void")) return true;

  // Homogeneous array compatibility: observed `T[]` matches declared `T[]`.
  if (observed.endsWith("[]")) {
    const elem = observed.slice(0, -2).trim();
    return declaredVariants.some(
      (v) => v.endsWith("[]") && observedFits(elem, [v.slice(0, -2).trim()]),
    );
  }

  return false;
}
