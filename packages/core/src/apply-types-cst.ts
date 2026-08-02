import ts from "typescript";

import type { ApplyTelemetry, ApplyTypesOptions } from "./contract.js";
import type { CollectedTypeInfo } from "./type-collector.js";

import { advanceCurrentSource } from "./apply-types-verify.js";
import { applyTypesToFile } from "./apply-types.js";
import { INFER_DEFAULTS } from "./configuration.js";
import { buildCstReplacements } from "./cst-replacements.js";
import { routeEntries } from "./cst-routing.js";
import { buildCstSiteIndex } from "./cst-site-index.js";
import { buildNamedTypeIndex, type NamedTypeIndex } from "./named-type-rewrite.js";
import { applyReplacements } from "./replacement.js";
import {
  buildCtorArityMap,
  buildScopedTypeNames,
  buildScopedTypeNamesViaTypeChecker,
} from "./scope-reachability.js";

/**
 * AST-aware applier — the default path (`infer.cstAware: true`). The
 * string-offset-based applyTypesToFile can drop a type at the wrong
 * site when offsets get stale; an AST-driven apply step sidesteps
 * that bug class and folds idempotency into the same pass. This
 * applier handles the common cases directly off the AST and routes
 * the rest through the offset-based path with offsets rebased to
 * account for CST insertions.
 *
 * Scope:
 *
 * - **AST path (handled here directly)**:
 *   - Parameter annotations on FunctionDeclaration, MethodDeclaration,
 *     ArrowFunction, FunctionExpression, ConstructorDeclaration. Both
 *     identifier-named and BindingPattern-named (object / array
 *     destructure) params are indexed; idempotency comes from
 *     `node.type !== undefined`; optional bindings read
 *     `node.questionToken`. Paren-less single-param arrow context is
 *     detected from `node.parent` and triggers a `(` insert at the
 *     param start in addition to the `: T)` insert at name.end.
 *   - Return-type annotations on the same function-like nodes when the
 *     function has no existing return type. Insertion offset is the
 *     `)` end (or `parameters.end` for paren-less arrows, mirroring
 *     `findCloseParenPos`'s same fix).
 *   - VariableDeclaration + PropertyDeclaration with an initializer
 *     when the binding has no existing type. Three guards expressed
 *     directly against the AST: `hasType` for idempotency,
 *     `rhsIsFunction` to skip outer annotation when RHS is a function
 *     expression (would conflict with inner observations), and
 *     `inferTypeFromInitializer` + the binding's literal-narrowing
 *     flag for `infer.skipInferableVarDecls`.
 *   - `this` parameter annotations: insertion at
 *     `function.parameters.pos` (right after the opening `(`). Whether
 *     the comma separator is needed comes from
 *     `parameters.length > 0` on the AST — no `thisNeedsComma` flag
 *     required from the producer side. CST is strictly more robust
 *     than the offset-based path here: legacy / third-party dump files
 *     missing the flag still produce correct output.
 * - **Pass-through path (delegated to applyTypesToFile, with offset
 *   rebasing)**: any entry whose pos doesn't match a known AST site.
 *   In practice this means stale offsets and exotic shapes the
 *   visitor doesn't yet recognise. Common cases now all flow through
 *   CST.
 *
 * Offset rebasing: after the CST pass inserts text at known offsets,
 * any pass-through entry whose original pos was AFTER one of those
 * offsets needs its pos shifted by the cumulative inserted length.
 * Without this, applyTypesToFile would splice into the post-CST
 * source at stale offsets and produce mangled output. The rebase is
 * a single sorted-merge pass — see `rebaseOffset` below.
 *
 * Edits are emitted as string replacements at AST-derived offsets, NOT
 * via the TS printer. The shared `computeAnnotationTypeString` helper
 * means both paths produce byte-identical type strings on the same
 * input — only the site-selection differs.
 *
 * ## Source-map fidelity (deferred)
 *
 * Full source-map emission would let the apply step ship a `.map`
 * alongside each rewritten file, mapping every modified line back to
 * the original source. Three implementation paths considered:
 *
 *  1. **TS printer** (`ts.createPrinter` with source-map option). The
 *     standard TS Compiler API path. Drawback: re-emits the ENTIRE
 *     source from the AST, destroying diff fidelity for every line
 *     including those we didn't touch. Unacceptable for an applier
 *     whose output is meant to be reviewed in `git diff`.
 *  2. **ts-morph**. Wraps the Compiler API and does targeted
 *     mutation-with-text-preservation under the hood — exactly the
 *     model we want. Cost: ~5MB extra dep on every ts-capture install,
 *     plus an external API surface to track for breaking changes
 *     between TS versions.
 *  3. **Partial-emit printer.** Build a printer that emits source
 *     maps for the changed regions only and preserves original text
 *     verbatim everywhere else. Conceptually the right answer.
 *     Doesn't exist yet; would need to write it.
 *
 * **Decision: defer indefinitely.** ts-capture's apply step is a
 * one-time annotation pass — its output is committed to source, then
 * users build / debug from the new source. Source maps matter for
 * BUILD-TIME transformers where the runtime executes the transformed
 * code; they matter much less for source-rewrite tools. If a real
 * use case shows up — typically "I want stack traces in production
 * logs to point at the pre-ts-capture lines for git-blame purposes" —
 * we revisit and pick path (2) or (3).
 */
export function applyTypesToFileCst(
  source: string,
  typeInfo: CollectedTypeInfo,
  options: ApplyTypesOptions,
  program?: ts.Program,
): string {
  // Per-file ignore — short-circuit before any AST work.
  if (
    options.filename &&
    options.ignoreFiles &&
    options.ignoreFiles.some((p) => p.test(options.filename!))
  ) {
    return source;
  }
  const infer = options.infer ?? INFER_DEFAULTS;
  const prefix = options.prefix ?? "";
  // Unified named-type index (exact + subset) for substituting structural
  // annotations with the matching in-scope interface / type alias. Off
  // unless `preferNamedInScope`; the builder owns the cross-file vs
  // same-file scope decision (mirrors offset path).
  const namedTypeIndex: NamedTypeIndex | undefined = infer.preferNamedInScope
    ? buildNamedTypeIndex(source, program, options.filename)
    : undefined;
  // Scope check (mirrored from offset path). Prefers TypeChecker when
  // Program + filename available.
  const scopedTypeNames: Set<string> | undefined = (() => {
    if (!infer.requireTypeRefInScope) return undefined;
    if (program && options.filename) {
      const fromTC = buildScopedTypeNamesViaTypeChecker(program, options.filename);
      if (fromTC) return fromTC;
    }
    return buildScopedTypeNames(source, options.filename);
  })();

  // Arity map for expanding bare generic class/interface names.
  const ctorArityMap: Map<string, number> | undefined =
    program && options.filename ? buildCtorArityMap(program, options.filename) : undefined;

  const sf = ts.createSourceFile(
    "__ts-capture_apply_cst.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  // --- Build AST-site indices ---

  const cstIndex = buildCstSiteIndex(sf, source, infer);
  const telemetry = options.telemetry;

  // --- Route entries: AST-eligible vs pass-through ---

  const { eligible: deduped, passThrough } = routeEntries(typeInfo, cstIndex, infer, telemetry);

  // --- Build CST replacements ---

  const cstReplacements = buildCstReplacements(deduped, cstIndex, {
    infer,
    prefix,
    program,
    verify: options.verify,
    telemetry,
    namedTypeIndex,
    scopedTypeNames,
    ctorArityMap,
  });

  const afterCst = applyReplacements(source, cstReplacements);

  if (passThrough.length === 0) return afterCst;

  // Advance the verify context's in-memory source to match
  // `afterCst` so the pass-through delegate's verify probes land at
  // the correct (rebased) offsets. The accepted CST candidates were
  // already proved not to introduce new diagnostics, so no
  // re-baselining is needed — `advanceCurrentSource` is the cheap
  // variant of `commitReplacements` that skips the cross-file scan.
  if (options.verify) {
    advanceCurrentSource(options.verify, afterCst);
  }

  // --- Rebase pass-through offsets through CST insertions ---
  //
  // The CST pass inserted text at known offsets in the original source.
  // Each pass-through entry's `pos` is relative to the original source;
  // to splice into `afterCst` correctly, shift each pos by the
  // cumulative length of CST insertions whose offset is STRICTLY less
  // than the pass-through pos. Strict less-than handles the param-end
  // == retPos collision case correctly: when both inserts target the
  // same offset, the offset-based path needs to land AFTER the CST
  // insertion, which is exactly what `pos + shift` produces.
  const sortedInsertions = cstReplacements
    .filter((r) => r.start === r.end)
    .map((r) => ({ pos: r.start, len: r.text.length }))
    .sort((a, b) => a.pos - b.pos);

  function rebaseOffset(pos: number): number {
    let shift = 0;
    for (const ins of sortedInsertions) {
      if (ins.pos < pos) shift += ins.len;
      else break;
    }
    return pos + shift;
  }

  const rebasedPassThrough: CollectedTypeInfo = passThrough.map(([file, pos, types, opts]) => [
    file,
    rebaseOffset(pos),
    types,
    opts,
  ]);

  // Telemetry handoff: the CST loop above already counted every
  // input entry in `totalEntries`. The passThrough delegate to the
  // offset applier would re-count those same entries. Give the
  // delegate a SUB-telemetry it can freely increment, then merge its
  // skip / emit counts back into the outer telemetry — but skip
  // `totalEntries` (the outer count is the authoritative one).
  const sub: ApplyTelemetry | undefined = telemetry
    ? {
        totalEntries: 0,
        emitted: 0,
        idempotent: 0,
        unparseable: 0,
        positionMismatch: 0,
        verifyReject: 0,
      }
    : undefined;
  const innerOptions = sub ? { ...options, telemetry: sub } : options;
  const result = applyTypesToFile(afterCst, rebasedPassThrough, innerOptions, program);
  if (telemetry && sub) {
    telemetry.emitted += sub.emitted;
    telemetry.idempotent += sub.idempotent;
    telemetry.unparseable += sub.unparseable;
    telemetry.positionMismatch += sub.positionMismatch;
    telemetry.verifyReject += sub.verifyReject;
  }
  return result;
}
