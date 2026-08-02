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

  const finalType = stripAllChainMarkers(sortedTypes.join("|"));

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
      const candidate = stripAllChainMarkers(collapsed.sort().join("|"));
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
function isUselessArrow(t: string): boolean {
  const m = t.match(/^\(([^)]*)\) => unknown$/);
  if (!m) return false;
  const inner = (m[1] ?? "").trim();
  if (inner === "") return false;
  const params = inner.split(",").map((p) => p.trim());
  return params.every((p) => /^\.\.\.\w+: unknown\[\]$/.test(p) || /^\w+: unknown$/.test(p));
}
