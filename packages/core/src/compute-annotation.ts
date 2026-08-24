import ts from "typescript";

import type { DiscoveredType } from "./collector-contract.js";
import type { InferOptions } from "./configuration.js";
import type { ExtraOptions, SourceLocation } from "./type-collector.js";

import { rewriteCommonBase, stripAllChainMarkers } from "./class-chain.js";
import { applyMemberFilters, type Priority, type UnconditionalFilter } from "./member-filters.js";
import { unwrapOneLevelPromise } from "./named-type-rewrite.js";
import { collapseLiteral, mergeTypes } from "./type-merge.js";

function findType(
  program: ts.Program | undefined,
  typeName: string | undefined,
  sourcePos: SourceLocation | undefined,
): string | undefined {
  if (program && sourcePos) {
    const [sourceName, sourceOffset] = sourcePos;
    const typeChecker = program.getTypeChecker();
    let foundType: string | null = null;

    function visit(node: ts.Node) {
      if (node.getStart() === sourceOffset) {
        const type = typeChecker.getTypeAtLocation(node);
        foundType = typeChecker.typeToString(type);
      }
      ts.forEachChild(node, visit);
    }

    const sourceFile = program.getSourceFile(sourceName);
    if (sourceFile) {
      visit(sourceFile);
      if (foundType && foundType !== "any") {
        return foundType;
      }
    }
  }
  return typeName ?? undefined;
}

/**
 * Compute the final type-string an apply step would write at one
 * insertion site, given the raw observed types from a single typeInfo
 * entry. Includes the full pipeline:
 *
 *   - findType resolution (TypeChecker-based, when program is provided)
 *   - literal collapse (gated by `infer.literal.*` flags)
 *   - dedup
 *   - merge stages (object/array merge, RewriteMostSpecificCommonBase)
 *   - undefined-strip for optional bindings
 *   - Promise wrapping for async return types
 *   - final `@sa:` chain-marker scrub
 *
 * Returns the bare type-string (e.g. `"number"`, `"Cat | Dog"`,
 * `"{ a: number }"`) — the caller is responsible for prefixing with
 * `: ` and any thisType / parens / suffix shaping. Returns `null` if
 * every observed type was filtered out (e.g. all-undefined for an
 * optional param) or if the observations vector was empty to begin
 * with.
 *
 * Shared between the offset-based `applyTypesToFile` and the
 * AST-aware `applyTypesToFileCst` (apply-types-cst.ts) so both paths
 * produce byte-identical type strings on the same input.
 */
export function computeAnnotationTypeString(
  types: DiscoveredType[],
  opts: ExtraOptions | undefined,
  infer: InferOptions,
  isOptionalBinding: boolean,
  program?: ts.Program,
): string | null {
  let sortedTypes = types
    .map(([name, sourcePos]) => findType(program, name, sourcePos))
    .filter((t): t is string => t != null)
    .sort();

  sortedTypes = sortedTypes.map((t) => collapseLiteral(t, infer));
  sortedTypes = [...new Set(sortedTypes)];
  // Snapshot of types BEFORE `mergeTypes` so the length-cap fallback has
  // access to the original `@sa:` chain markers, which mergeTypes strips
  // when `infer.rewriteCommonBase` is off (the default).
  const preMergeTypes = sortedTypes;
  sortedTypes = mergeTypes(sortedTypes, infer).sort();

  // Declarative member-filter chain. Each rule that fits the
  // `{high, low}` or "drop matching" shape lives in this list instead of
  // a nested `.filter()` chain — easier to read, easier to spot
  // redundancies.
  const unconditional: UnconditionalFilter[] = [
    {
      // An empty-array observation yields `unknown[]` with no element-type
      // info. When that placeholder is locked inside a structural object
      // type, emitting it forces every reader of the field to handle
      // `unknown[]` — breaking call-sites that would otherwise infer a
      // useful element type from the literal. So drop the whole candidate.
      name: "Drop object-shape with unknown[] field",
      drop: hasUnknownArrayField,
    },
  ];
  if (isOptionalBinding) {
    // Optional binding: a `?:` annotation already includes `undefined`
    // implicitly in the parameter type. Listing it explicitly is
    // redundant and noisier.
    unconditional.push({
      name: "Optional-binding: drop `undefined`",
      drop: (t) => t === "undefined",
    });
  }

  const priorities: Priority[] = [
    {
      // Drop `unknown[]` from the union when at least one other
      // entry is also an array-shaped type. `unknown[]` is the inferred
      // type for an empty array observation — a subtype of every
      // concrete `T[]`, so dropping it loses no information when paired
      // with a real array. Keep `unknown[]` when it's the only array
      // (carries the "value was an array" signal alone) or when all
      // peers are non-array.
      name: "Drop unknown[] when concrete array present",
      high: (t) => t !== "unknown[]" && isArrayShapedType(t),
      low: (t) => t === "unknown[]",
    },
  ];

  sortedTypes = applyMemberFilters(sortedTypes, unconditional, priorities);

  if (sortedTypes.length === 0) return null;

  // Idiomatic return types: a function body that doesn't intentionally
  // return (event handlers, side-effect callbacks, `state => handle(state)`)
  // is typed `void` in TS — `undefined` is a stricter type that rejects
  // most callsite bodies. Both ts-capture-observe as `undefined` at runtime,
  // so when the ONLY observation is `undefined` we widen to `void`.
  // Union returns like `string | undefined` stay as-is (those imply the
  // function sometimes returns a value, sometimes not — `undefined` is
  // the right component there).
  if (opts?.returnType && sortedTypes.length === 1 && sortedTypes[0] === "undefined") {
    sortedTypes = ["void"];
  }

  if (opts?.returnType && opts?.async) {
    // When the body returns an existing Promise, the
    // observation IS `Promise<T>` — wrapping it again in async's outer
    // `Promise<>` produces `Promise<Promise<T>>`, which TS would unwrap
    // for us. Unwrap each `Promise<X>`-shaped branch first; mixed unions
    // (`Promise<X> | Y`) flatten to `Promise<X | Y>`.
    const unwrapped = sortedTypes.map(unwrapOneLevelPromise);
    const inner = unwrapped.join(" | ");
    sortedTypes = [`Promise<${inner}>`];
  }

  // Suppress annotation when the SOLE observed type is a "useless"
  // arrow — every parameter typed `unknown` (or rest `unknown[]`) AND
  // return `unknown`. These accumulate when a callback varDecl is
  // observed but the callback is never invoked during the run; the
  // emitted shape locks the param count without adding type information.
  // Skip rather than annotate so apply produces no noise.
  //
  // Gated by `emitDiagnosticComments`: in diagnostic mode, users
  // explicitly want to see where ts-capture's coverage has gaps, so
  // we preserve the annotation (and downstream marker emission) instead
  // of dropping it silently.
  if (
    !infer.emitDiagnosticComments &&
    sortedTypes.length === 1 &&
    isUselessArrow(sortedTypes[0]!)
  ) {
    return null;
  }

  const finalType = stripAllChainMarkers(joinUnion(sortedTypes));

  // Refuse to write a type that does not describe the value.
  //
  // Generalises `isUselessArrow` above: `unknown` or `any` anywhere in the
  // annotation means the run saw the value but could not say what it was.
  // `Promise<unknown>` reports that something is a Promise while discarding
  // the part a reader needs, and where the checker already had a real type it
  // is a downgrade. On nestjs/nest this was the largest single group in the
  // diff — 106 of 366 emitted fragments, led by 25 `Promise<unknown>`,
  // 7 `Map<unknown, unknown>` and 6 each of `Set<unknown>` and
  // `Observable<unknown>`.
  //
  // Same diagnostic-mode escape as `isUselessArrow`: with
  // `emitDiagnosticComments` on, the user is asking to see where coverage is
  // thin, so the gaps stay visible.
  if (!infer.emitDiagnosticComments && carriesNoInformation(finalType)) {
    return null;
  }

  // Suppress the annotation when the final union exceeds the
  // configured cap. A 19K-char annotation locks the entire observed
  // shape into source and is less readable than letting TS infer or
  // the user type the position themselves.
  if (finalType.length > infer.maxAnnotationChars) {
    // Common-base fallback. When the
    // union members carry `@sa:` chain markers and share a common
    // ancestor, fall back to that base before dropping. We force the
    // rewriteCommonBase flag on for this last-resort pass — the user's
    // config gate controls EARLY collapse (which may or may not be
    // desired), but at this fallback boundary the alternatives are
    // "common base" vs "no annotation at all", so the base is always
    // preferable.
    const collapsed = rewriteCommonBase(preMergeTypes, { ...infer, rewriteCommonBase: true });
    if (collapsed.length < preMergeTypes.length) {
      const candidate = stripAllChainMarkers(joinUnion(collapsed.sort()));
      if (candidate.length <= infer.maxAnnotationChars) {
        return candidate;
      }
    }
    return null;
  }

  return finalType;
}

/**
 * Detect any array-shaped type: `T[]`, `Array<...>`, or `{ ... }[]` (a
 * suffixed object-shape). Used by the unknown[]-drop filter — we
 * only collapse `unknown[]` from a union when there is another array
 * to defer the "shape is an array" signal to.
 *
 * NOT the same as isSimpleArrayType (which constrains to atom-element
 * arrays only). Here we also accept object-shape arrays since they
 * still convey "this is an array".
 */
function isArrayShapedType(t: string): boolean {
  if (t === "unknown[]") return false;
  // T[] or { ... }[] — anything ending in [] at the top level
  if (t.endsWith("[]")) return true;
  // Array<...>
  if (/^Array<.*>$/.test(t)) return true;
  return false;
}

/**
 * Detect an object-shape type that has a field annotated as `unknown[]`.
 * Used to suppress annotations where ts-capture observed an empty
 * array in an object-field position — the resulting structural type would
 * lock `unknown[]` into source and break downstream consumers expecting
 * a more specific element type.
 *
 * The check walks the string tracking depth inside `{ ... }` blocks, and
 * matches `<key>: unknown[]` followed by a field terminator (`,`, `}`, or
 * end-of-string). Limiting to top-level field terminators avoids false
 * positives like `(x: unknown[]) => void` where `unknown[]` is a function
 * parameter (terminated by `)`), and `Map<X, unknown[]>` where it's a
 * generic argument (no enclosing `{`).
 */
function hasUnknownArrayField(t: string): boolean {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      continue;
    }
    if (depth === 0) continue;
    // Inside an object brace: look for `<key>?: unknown[]` followed by a
    // field terminator.
    const m = /^\s*\??:\s*unknown\[\]\s*(?=[,}]|$)/.exec(t.slice(i));
    if (m && /\w/.test(t[i - 1] ?? "")) {
      return true;
    }
  }
  return false;
}

/**
 * Detect an inferred function-type whose params and return are all
 * `unknown` — the residue of observing a callback that was never invoked.
 * Matches:
 *   (arg: unknown) => unknown
 *   (a: unknown, b: unknown) => unknown
 *   (...args: unknown[]) => unknown
 *   (a: unknown, ...rest: unknown[]) => unknown
 *
 * Excludes `() => unknown` (zero-param) because a callable shape with no
 * args may still carry semantic intent even when the return is unknown.
 */
/**
 * Does the annotation describe nothing?
 *
 * True when every payload position in the type is `unknown` or `any` —
 * `Promise<unknown>`, `Map<unknown, unknown>`, `Set<unknown>`, `() => unknown`.
 * Knowing a value is a Promise while discarding what it resolves to is not
 * worth rewriting a line for, and where the checker already had a real type it
 * is a downgrade.
 *
 * A type is *not* vacuous as soon as one position is described:
 * `(arg: string) => unknown` still tells a reader the callback takes a string,
 * and `unknown[] | string` still names one arm. Those are kept deliberately.
 *
 * Parameter *names* do not count as payload — only the types they carry.
 * (An earlier draft walked every token and treated `argsArray` in
 * `(...argsArray: unknown[]) => Promise<unknown>` as information.)
 */
/**
 * Join observed types into a union, parenthesising function types.
 *
 * `((a: T) => R) | string` and `(a: T) => R | string` are different types —
 * the second is a function returning a union. Joining with a bare `|` emitted
 * the second while meaning the first. Surfaced on nestjs/nest by the vacuity
 * guard, which correctly read `(arg: unknown) => unknown|string` as a function
 * returning `unknown`.
 */
function joinUnion(types: readonly string[]): string {
  if (types.length < 2) return types.join("|");
  return types.map((t) => (isTopLevelFunctionType(t) ? `(${t})` : t)).join("|");
}

/** Does the type read as a function type at its top level? */
function isTopLevelFunctionType(t: string): boolean {
  const sf = ts.createSourceFile(
    "__union_probe.ts",
    `type __X = ${t};`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
  );
  const stmt = sf.statements[0];
  if (!stmt || !ts.isTypeAliasDeclaration(stmt)) return false;
  return ts.isFunctionTypeNode(stmt.type) || ts.isConstructorTypeNode(stmt.type);
}

export function carriesNoInformation(t: string): boolean {
  const sf = ts.createSourceFile(
    "__vacuity_probe.ts",
    `type __X = ${t};`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
  );
  const stmt = sf.statements[0];
  // Unparseable here means some other guard will reject it; do not also claim
  // it is vacuous.
  if (!stmt || !ts.isTypeAliasDeclaration(stmt)) return false;

  let describesSomething = false;

  const walk = (node: ts.Node): void => {
    if (describesSomething) return;

    switch (node.kind) {
      case ts.SyntaxKind.UnknownKeyword:
      case ts.SyntaxKind.AnyKeyword:
        return;
      default:
        break;
    }

    // `unknown` absorbs every union it appears in: `unknown | undefined` *is*
    // `unknown`. A union with an unknown member therefore describes nothing,
    // whatever its other arms say. (`mergeTypes` already collapses this at the
    // top level; inside a generic argument it does not.)
    if (ts.isUnionTypeNode(node)) {
      const absorbed = node.types.some(
        (t) => t.kind === ts.SyntaxKind.UnknownKeyword || t.kind === ts.SyntaxKind.AnyKeyword,
      );
      if (absorbed) return;
      // Only the arms that can carry a payload get to answer for the union.
      // `null` and `undefined` describe themselves and nothing else, so a
      // union whose every other arm is empty is empty too:
      // `((...args: unknown[]) => unknown) | null` says no more than
      // `unknown | null` does. Walking every arm let the nullish one speak for
      // the union and kept 11 such annotations on nestjs/nest.
      //
      // When there is no payload arm at all — `null`, `null | undefined` —
      // the nullish arms ARE the answer, and answer for themselves.
      const payload = node.types.filter((t) => !isNullishType(t));
      (payload.length > 0 ? payload : node.types).forEach(walk);
      return;
    }

    if (ts.isTypeReferenceNode(node)) {
      const args = node.typeArguments ?? [];
      // A bare `Foo` is the whole answer. `Promise<unknown>` is not — the
      // constructor name alone does not describe the value it carries.
      if (args.length === 0) {
        describesSomething = true;
        return;
      }
      args.forEach(walk);
      return;
    }

    // Function-like: the names are ours to ignore, the types are not.
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
      node.parameters.forEach((p) => p.type && walk(p.type));
      if (node.type) walk(node.type);
      return;
    }

    if (ts.isTypeLiteralNode(node)) {
      node.members.forEach((m) => {
        if ((ts.isPropertySignature(m) || ts.isMethodSignature(m)) && m.type) walk(m.type);
      });
      return;
    }

    // Any other keyword type — string, number, boolean, void, null, never,
    // a literal type — describes the value.
    if (ts.isToken(node)) {
      describesSomething = true;
      return;
    }

    ts.forEachChild(node, walk);
  };

  walk(stmt.type);
  return !describesSomething;
}

/**
 * `null`, `undefined` or `void` — the types that describe only their own
 * absence of a value. Everything else is a payload, however vague.
 *
 * `void` sits here for the same reason `observedBeyondInferred` settles it to
 * `undefined`: as a union arm it makes one claim, that there is nothing there.
 * Leaving it out let `Promise<unknown>|void` read as informative while
 * `Promise<unknown>|undefined` did not.
 *
 * A union of nothing but these is still the answer — see the caller.
 */
function isNullishType(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (node.kind === ts.SyntaxKind.VoidKeyword) return true;
  return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
}

function isUselessArrow(t: string): boolean {
  const m = t.match(/^\(([^)]*)\) => unknown$/);
  if (!m) return false;
  const inner = (m[1] ?? "").trim();
  if (inner === "") return false;
  const params = inner.split(",").map((p) => p.trim());
  return params.every((p) => /^\.\.\.\w+: unknown\[\]$/.test(p) || /^\w+: unknown$/.test(p));
}
