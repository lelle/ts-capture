import ts from "typescript";

import type { InferOptions } from "./configuration.js";
import type { ApplyTelemetry } from "./contract.js";
import type { RoutedEntry } from "./cst-routing.js";
import type { CstSiteIndex } from "./cst-site-index.js";

import { suppressArrayCallbackStructural } from "./annotation-eligibility.js";
import { buildDiagnosticMarkerSuffix } from "./apply-diagnostics.js";
import { filterAcceptedReplacements, type VerificationContext } from "./apply-types-verify.js";
import { computeAnnotationTypeString } from "./compute-annotation.js";
import { inferTypeFromInitializer } from "./initializer-inference.js";
import { type NamedTypeIndex, rewriteToNamedInScope } from "./named-type-rewrite.js";
import { isParseableTypeString } from "./parseable.js";
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
  } = ctx;

  const cstReplacements: Replacement[] = [];
  // When verify is enabled, buffer annotation insertions here and decide
  // acceptance in a single batch pass at the end of the loop. Structural
  // inserts (paren wraps for paren-less arrows, separator commas for `this:`)
  // still go directly into `cstReplacements` — matching the offset-based
  // pattern where the wrap is unconditional and only the annotation text is
  // gated by verify.
  const annotationCandidates: AnnotationCandidate[] = [];

  function pushOrBufferAnnotation(pos: number, text: string, priority?: number): void {
    if (verify) {
      annotationCandidates.push({ pos, text, priority });
    } else {
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
          cstReplacements.push(Replacement.insert(site.parensOpenPos, "("));
          cstReplacements.push(Replacement.insert(pos, ")"));
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
          cstReplacements.push(Replacement.insert(site.parensOpenPos, "("));
          cstReplacements.push(Replacement.insert(pos, ")"));
        }
        continue;
      }
      // Parse-check — refuse to write an unparseable type.
      if (!isParseableTypeString(emitted)) continue;
      // Paren-less single-param arrow: wrap with `()` separately so the
      // annotation can be gated through verify independently. Wrap
      // pushes unconditionally — if verify rejects the annotation,
      // `(x) => body` stays as harmless valid syntax. Priority scheme:
      // `)` priority 0, param annotation priority 1 — sorts so the
      // annotation lands BEFORE the `)` in the output, yielding
      // `(x: T) => body`. Mirrors the offset-based path.
      if (site.parensOpenPos !== undefined) {
        cstReplacements.push(Replacement.insert(site.parensOpenPos, "("));
        cstReplacements.push(Replacement.insert(pos, ")", 0));
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
      // Lower priority than param inserts so the priority-tied
      // collision case from the offset-based path (paren-less arrow:
      // both inserts at same pos) is handled the same way. In this
      // CST path paren-less arrows are gated out (single-param +
      // paren-less goes through `parens` opt → passThrough), so this
      // is purely defensive.
      // Parse-check.
      if (!isParseableTypeString(emitted)) continue;
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
      // Skip when TS would already infer the same type from the
      // initializer. Only fires when both `infer.skipInferableVarDecls`
      // is on AND the initializer is a shape we can model exactly.
      if (infer.skipInferableVarDecls && site.initializer) {
        const inferredFromSource = inferTypeFromInitializer(site.initializer, site.narrowsLiterals);
        if (inferredFromSource !== null && inferredFromSource === emitted) continue;
      }
      // Parse-check.
      if (!isParseableTypeString(emitted)) continue;
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
      if (telemetry) telemetry.emitted++;
    }
    if (telemetry) {
      telemetry.verifyReject += annotationCandidates.length - acceptedSet.size;
    }
  }

  return cstReplacements;
}
