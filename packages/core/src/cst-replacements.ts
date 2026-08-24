import ts from "typescript";

import type { InferOptions } from "./configuration.js";
import type { ApplyTelemetry } from "./contract.js";
import type { RoutedEntry } from "./cst-routing.js";
import type { CstSiteIndex } from "./cst-site-index.js";

import { suppressArrayCallbackStructural } from "./annotation-eligibility.js";
import { buildDiagnosticMarkerSuffix } from "./apply-diagnostics.js";
import { filterAcceptedReplacements, type VerificationContext } from "./apply-types-verify.js";
import { carriesNoInformation, computeAnnotationTypeString } from "./compute-annotation.js";
import {
  hasConstAssertion,
  inferTypeFromInitializer,
  isSymbolCall,
} from "./initializer-inference.js";
import { type NamedTypeIndex, rewriteToNamedInScope } from "./named-type-rewrite.js";
import { isParseableTypeString } from "./parseable.js";
import {
  carriesPolymorphicThis,
  discardsUnionArm,
  erasesEnum,
  erasesNamedType,
  inferredReturnType,
  isRedundantAnnotation,
  typeAt,
  writesOverCallSignature,
} from "./redundant-annotation.js";
import { type AnnotationCandidate, Replacement } from "./replacement.js";
import { allTypeRefsInScope, expandCtorArity } from "./scope-reachability.js";

// Replacement-building for the AST-aware applier. Turns
// the routed CST-eligible entries into a list of `Replacement`s, running each
// candidate through the shared annotation pipeline (computeAnnotationTypeString
// → rewriteToNamedInScope → expandCtorArity → allTypeRefsInScope →
// isParseableTypeString) and the batch verify pass.

/**
 * Everything the replacement builder needs beyond the site index — the
 * per-file inference flags, emission prefix, optional Program / verify
 * context, telemetry sink, and the named-type / scope / ctor-arity indices
 * built once by the orchestrator.
 */
export interface CstApplyContext {
  infer: InferOptions;
  prefix: string;
  program?: ts.Program;
  /**
   * Site index built over the Program's own SourceFile, keyed identically to
   * `index`. The checker can only answer about nodes it owns, and `index` is
   * built from a detached parse of the source string.
   */
  checkerIndex?: CstSiteIndex;
  verify?: VerificationContext;
  telemetry?: ApplyTelemetry;
  namedTypeIndex?: NamedTypeIndex;
  scopedTypeNames?: Set<string>;
  ctorArityMap?: Map<string, number>;
}

/**
 * Build the CST-anchored replacement list from the deduped eligible entries.
 * Structural inserts (paren wraps, `this:` separators) go in unconditionally;
 * annotation text is buffered and gated through a single batch verify pass when
 * `ctx.verify` is set.
 */
export function buildCstReplacements(
  eligible: Map<string, RoutedEntry>,
  index: CstSiteIndex,
  ctx: CstApplyContext,
): Replacement[] {
  const { paramSites, thisTypeSites, varDeclSites, arrayCallbackArrowParams } = index;
  const {
    infer,
    prefix,
    program,
    verify,
    telemetry,
    namedTypeIndex,
    scopedTypeNames,
    ctorArityMap,
    checkerIndex,
  } = ctx;

  // Checker-backed redundancy oracle: is the annotation we are about to write
  // already implied by TypeScript's own inference? Undefined when apply runs
  // outside a project (`getProgram` returns undefined with no tsconfig), in
  // which case each site falls back to its syntactic guard.
  // Built whenever a project is available. `skipRedundantAnnotations` says
  // whether a *restatement* is worth writing; it does not say whether apply may
  // erase an enum, drop a union arm or overwrite a polymorphic `this`. Gating
  // the checker itself on it turned every one of those guards off together —
  // and `discardsUnionArm` guards the direction that introduces an error rather
  // than removing one.
  const checker = checkerIndex ? program?.getTypeChecker() : undefined;

  const cstReplacements: Replacement[] = [];
  // When verify is enabled, buffer annotation insertions here and decide
  // acceptance in a single batch pass at the end of the loop.
  const annotationCandidates: AnnotationCandidate[] = [];

  // Paren wraps for paren-less arrows (`x => …` needs `(x) => …` before an
  // annotation can attach) are deferred the same way, keyed by the position
  // the `)` goes at — which is also the position any annotation lands at.
  //
  // The wrap must outlive *one* entry being skipped, because a sibling entry
  // at the same position may still land: a rejected param annotation and an
  // accepted returnType annotation share this offset. But when nothing lands
  // there the parens are pure diff noise — `key => …` rewritten to
  // `(key) => …` with no type gained. A nest run produced 175 such lines, 36%
  // of the whole diff. So: record the wrap, and materialise it at the end only
  // if some annotation at that position survived.
  const pendingWraps = new Map<number, number>();
  const annotatedPositions = new Set<number>();

  function requestParenWrap(openPos: number, closePos: number): void {
    if (!pendingWraps.has(closePos)) pendingWraps.set(closePos, openPos);
  }

  function pushOrBufferAnnotation(pos: number, text: string, priority?: number): void {
    if (verify) {
      annotationCandidates.push({ pos, text, priority });
    } else {
      annotatedPositions.add(pos);
      cstReplacements.push(Replacement.insert(pos, text, priority ?? 0));
      if (telemetry) telemetry.emitted++;
    }
  }

  for (const { entry, kind } of eligible.values()) {
    const [, pos, types, opts] = entry;
    // Shared marker-comment suffix; appended after the type and before
    // any structural suffix (`)` for paren-less arrow wrap, `, ` for
    // thisType-with-other-params).
    const markerSuffix = buildDiagnosticMarkerSuffix(types, infer);

    if (kind === "param") {
      const site = paramSites.get(pos)!;
      const isOptional = !!site.node.questionToken;
      const computed = computeAnnotationTypeString(types, opts, infer, isOptional, program);
      if (computed === null) continue;
      const named = rewriteToNamedInScope(computed, namedTypeIndex);
      const emitted = ctorArityMap ? expandCtorArity(named, ctorArityMap) : named;
      if (!allTypeRefsInScope(emitted, scopedTypeNames)) {
        // Paren-less single-param arrow: even when we skip emitting the
        // param annotation, the sibling returnType entry will try to
        // land `: T` at the same pos. Without the `()` wrap, the result
        // is broken `name: T => body` syntax. Install the wrap so
        // returnType lands inside.
        if (site.parensOpenPos !== undefined) {
          requestParenWrap(site.parensOpenPos, pos);
        }
        continue;
      }
      // Inside an Array.prototype callback, skip the
      // annotation when emitted is a structural object type (`{ ... }`).
      // Primitives still pass through — they're cheap confirmations of
      // the contextual type.
      //
      // For paren-less single-param arrows we must still emit the `()`
      // wrap so any sibling returnType annotation on the same position
      // lands inside parens (otherwise we'd produce broken
      // `filter(product: boolean =>` output).
      if (
        opts?.arrow &&
        suppressArrayCallbackStructural(arrayCallbackArrowParams.has(pos), emitted)
      ) {
        if (site.parensOpenPos !== undefined) {
          requestParenWrap(site.parensOpenPos, pos);
        }
        continue;
      }
      // Parse-check — refuse to write an unparseable type.
      if (!isParseableTypeString(emitted)) continue;
      // Re-check the FINAL string: `rewriteToNamedInScope` and
      // `expandCtorArity` run after `computeAnnotationTypeString`, and arity
      // expansion in particular turns a keepable bare `Container` into
      // `Container<unknown>`, which describes no payload.
      if (!infer.emitDiagnosticComments && carriesNoInformation(emitted)) continue;
      // Nothing to add when the checker already types this parameter — a
      // contextually typed callback param, for instance.
      const inferredParam = typeAt(checker, checkerIndex?.paramSites.get(pos)?.node.name);
      // `Function` over a signature the checker already has replaces an answer
      // with a shrug.
      if (writesOverCallSignature(checker, inferredParam, emitted)) continue;
      if (erasesNamedType(checker, inferredParam, emitted)) continue;
      if (erasesEnum(checker, inferredParam, emitted)) continue;
      if (discardsUnionArm(checker, inferredParam, emitted)) continue;
      if (
        infer.skipRedundantAnnotations &&
        isRedundantAnnotation(checker, inferredParam, emitted)
      ) {
        if (telemetry) telemetry.idempotent++;
        continue;
      }
      // Paren-less single-param arrow: wrap with `()` separately so the
      // annotation can be gated through verify independently. Wrap
      // pushes unconditionally — if verify rejects the annotation,
      // `(x) => body` stays as harmless valid syntax. Priority scheme:
      // `)` priority 0, param annotation priority 1 — sorts so the
      // annotation lands BEFORE the `)` in the output, yielding
      // `(x: T) => body`. Mirrors the offset-based path.
      if (site.parensOpenPos !== undefined) {
        requestParenWrap(site.parensOpenPos, pos);
        pushOrBufferAnnotation(pos, ": " + prefix + emitted + markerSuffix, 1);
      } else {
        pushOrBufferAnnotation(pos, ": " + prefix + emitted + markerSuffix);
      }
    } else if (kind === "thisType") {
      const site = thisTypeSites.get(pos)!;
      const computed = computeAnnotationTypeString(types, opts, infer, false, program);
      if (computed === null) continue;
      const named = rewriteToNamedInScope(computed, namedTypeIndex);
      const emitted = ctorArityMap ? expandCtorArity(named, ctorArityMap) : named;
      if (!allTypeRefsInScope(emitted, scopedTypeNames)) continue;
      // Parse-check.
      if (!isParseableTypeString(emitted)) continue;
      // Re-check the FINAL string: `rewriteToNamedInScope` and
      // `expandCtorArity` run after `computeAnnotationTypeString`, and arity
      // expansion in particular turns a keepable bare `Container` into
      // `Container<unknown>`, which describes no payload.
      if (!infer.emitDiagnosticComments && carriesNoInformation(emitted)) continue;
      // When the function already has params, the apply needs a
      // separator between `this: T` and the first real param.
      // Mirrors the offset-based path's opts.thisNeedsComma flag —
      // here read directly from the AST.
      const suffix = site.hasOtherParams ? ", " : "";
      pushOrBufferAnnotation(pos, "this: " + prefix + emitted + markerSuffix + suffix);
    } else if (kind === "returnType") {
      const computed = computeAnnotationTypeString(types, opts, infer, false, program);
      if (computed === null) continue;
      const named = rewriteToNamedInScope(computed, namedTypeIndex);
      const emitted = ctorArityMap ? expandCtorArity(named, ctorArityMap) : named;
      if (!allTypeRefsInScope(emitted, scopedTypeNames)) continue;
      // Same suppression as for arrow-param entries —
      // when the returnType lands on an Array.prototype callback's
      // arrow AND emitted is a structural shape, TS contextually types
      // the callback's return from the array's element type. Skip.
      if (suppressArrayCallbackStructural(arrayCallbackArrowParams.has(pos), emitted)) {
        continue;
      }
      const inferredReturn = inferredReturnType(
        checker,
        checkerIndex?.returnTypeSites.get(pos)?.node,
      );
      // `this` has no single value to write down. Any concrete type here —
      // however well observed — costs every subclass its own return type.
      if (carriesPolymorphicThis(checker, inferredReturn)) continue;
      if (writesOverCallSignature(checker, inferredReturn, emitted)) continue;
      if (erasesNamedType(checker, inferredReturn, emitted)) continue;
      if (erasesEnum(checker, inferredReturn, emitted)) continue;
      if (discardsUnionArm(checker, inferredReturn, emitted)) continue;
      // Nothing to add when the checker already infers this return type from
      // the body.
      if (
        infer.skipRedundantAnnotations &&
        isRedundantAnnotation(checker, inferredReturn, emitted)
      ) {
        if (telemetry) telemetry.idempotent++;
        continue;
      }
      // Lower priority than param inserts so the priority-tied
      // collision case from the offset-based path (paren-less arrow:
      // both inserts at same pos) is handled the same way. In this
      // CST path paren-less arrows are gated out (single-param +
      // paren-less goes through `parens` opt → passThrough), so this
      // is purely defensive.
      // Parse-check.
      if (!isParseableTypeString(emitted)) continue;
      // Re-check the FINAL string: `rewriteToNamedInScope` and
      // `expandCtorArity` run after `computeAnnotationTypeString`, and arity
      // expansion in particular turns a keepable bare `Container` into
      // `Container<unknown>`, which describes no payload.
      if (!infer.emitDiagnosticComments && carriesNoInformation(emitted)) continue;
      pushOrBufferAnnotation(pos, ": " + prefix + emitted + markerSuffix, -1);
    } else {
      // varDecl: user-written `as Type` / `<Type>` cast on RHS — defer
      // to the cast unless honorAsCasts is explicitly off.
      if (opts?.hasAsCast && infer.honorAsCasts) continue;
      const site = varDeclSites.get(pos)!;
      const computed = computeAnnotationTypeString(types, opts, infer, false, program);
      if (computed === null) continue;
      const named = rewriteToNamedInScope(computed, namedTypeIndex);
      const emitted = ctorArityMap ? expandCtorArity(named, ctorArityMap) : named;
      if (!allTypeRefsInScope(emitted, scopedTypeNames)) continue;
      // A const assertion is a narrowing the author asked for, and an
      // observation can only widen it. Unconditional, unlike
      // `skipRedundantAnnotations` below: asking for redundant annotations is
      // asking for restatement, not for destruction.
      if (site.initializer && hasConstAssertion(site.initializer)) continue;
      // A `unique symbol` is the same narrowing, inferred rather than
      // asked for: widening it to `symbol` is destruction, not
      // restatement, so it does not wait for the flag either.
      if (emitted === "symbol" && site.initializer && isSymbolCall(site.initializer)) continue;
      const inferredBinding = typeAt(checker, checkerIndex?.varDeclSites.get(pos)?.nameNode);
      // `const self = this` — the same erasure as on a return type, in a
      // binding. nest aliases `this` that way so a class expression can close
      // over it.
      if (carriesPolymorphicThis(checker, inferredBinding)) continue;
      if (writesOverCallSignature(checker, inferredBinding, emitted)) continue;
      if (erasesNamedType(checker, inferredBinding, emitted)) continue;
      if (erasesEnum(checker, inferredBinding, emitted)) continue;
      if (discardsUnionArm(checker, inferredBinding, emitted)) continue;
      // Skip when TS would already infer the same type from the
      // initializer. Only fires when both `infer.skipRedundantAnnotations`
      // is on AND the initializer is a shape we can model exactly.
      // Checker first: it answers this exactly and for every initializer
      // shape. The syntactic table below is the fallback for runs with no
      // project (`getProgram` returns undefined without a tsconfig).
      if (
        infer.skipRedundantAnnotations &&
        isRedundantAnnotation(checker, inferredBinding, emitted)
      ) {
        if (telemetry) telemetry.idempotent++;
        continue;
      }
      if (infer.skipRedundantAnnotations && site.initializer) {
        const inferredFromSource = inferTypeFromInitializer(site.initializer, site.narrowsLiterals);
        if (inferredFromSource !== null && inferredFromSource === emitted) continue;
      }
      // Parse-check.
      if (!isParseableTypeString(emitted)) continue;
      // Re-check the FINAL string: `rewriteToNamedInScope` and
      // `expandCtorArity` run after `computeAnnotationTypeString`, and arity
      // expansion in particular turns a keepable bare `Container` into
      // `Container<unknown>`, which describes no payload.
      if (!infer.emitDiagnosticComments && carriesNoInformation(emitted)) continue;
      pushOrBufferAnnotation(pos, ": " + prefix + emitted + markerSuffix);
    }
  }

  // Batch verify pass for the CST applier. Buffered
  // annotation candidates are probed in one shot (fast path: all-or-
  // nothing). If the batch introduces new diagnostics, bisect /
  // greedy fallback inside `filterAcceptedReplacements` picks the
  // largest safe subset. Only accepted candidates push their
  // insertion into `cstReplacements`; structural paren wraps already
  // pushed above stay regardless of verify outcome.
  if (verify && annotationCandidates.length > 0) {
    const probes = annotationCandidates.map((c) => ({
      start: c.pos,
      end: c.pos,
      text: c.text,
    }));
    const acceptedIdx = filterAcceptedReplacements(verify, probes);
    const acceptedSet = new Set(acceptedIdx);
    for (const i of acceptedIdx) {
      const c = annotationCandidates[i];
      cstReplacements.push(Replacement.insert(c.pos, c.text, c.priority ?? 0));
      annotatedPositions.add(c.pos);
      if (telemetry) telemetry.emitted++;
    }
    if (telemetry) {
      telemetry.verifyReject += annotationCandidates.length - acceptedSet.size;
    }
  }

  // Materialise only the wraps whose position actually received an
  // annotation. Priority 0 for the `)` puts it between a returnType
  // annotation (-1, ends up right of the paren) and a param annotation
  // (1, ends up left of it), yielding `(x: T): R => body`.
  for (const [closePos, openPos] of pendingWraps) {
    if (!annotatedPositions.has(closePos)) continue;
    cstReplacements.push(Replacement.insert(openPos, "("));
    cstReplacements.push(Replacement.insert(closePos, ")", 0));
  }

  return cstReplacements;
}
