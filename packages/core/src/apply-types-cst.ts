import ts from "typescript";

import type { ApplyTelemetry, ApplyTypesOptions } from "./contract.js";
import type { RoutedEntry } from "./cst-routing.js";
import type { CstSiteIndex } from "./cst-site-index.js";
import type { CollectedTypeInfo } from "./type-collector.js";

import { advanceCurrentSource } from "./apply-types-verify.js";
import { applyTypesToFile } from "./apply-types.js";
import { inferClassFieldTypes } from "./class-field-inference.js";
import { INFER_DEFAULTS, type InferOptions } from "./configuration.js";
import { buildCstReplacements, type CstApplyContext } from "./cst-replacements.js";
import { routeEntries } from "./cst-routing.js";
import { buildCheckerSiteIndex, buildCstSiteIndex } from "./cst-site-index.js";
import { buildNamedTypeIndex, type NamedTypeIndex } from "./named-type-rewrite.js";
import { applyReplacements, type Replacement } from "./replacement.js";
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
 *     flag for `infer.skipRedundantAnnotations`.
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
  const scopedTypeNames = scopedTypeNamesFor(source, program, options.filename, infer);
  // Unified named-type index (exact + subset) for substituting structural
  // annotations with the matching in-scope interface / type alias. Off
  // unless `preferNamedInScope`; the builder owns the cross-file vs
  // same-file scope decision (mirrors offset path).
  const namedTypeIndex: NamedTypeIndex | undefined = infer.preferNamedInScope
    ? buildNamedTypeIndex(source, program, options.filename, scopedTypeNames)
    : undefined;

  // Arity map for expanding bare generic class/interface names.
  const ctorArityMap: Map<string, number> | undefined =
    program && options.filename ? buildCtorArityMap(program, options.filename) : undefined;

  const sf = parseDetached(source);

  // --- Build AST-site indices ---

  const cstIndex = buildCstSiteIndex(sf, source, infer);

  // A second index over the *Program's* SourceFile, keyed identically: `sf`
  // above is detached, and the checker cannot answer about its nodes.
  const checkerIndex = buildCheckerSiteIndex(program, options.filename, source, infer);
  const telemetry = options.telemetry;

  // --- Route entries: AST-eligible vs pass-through ---

  // A field's type comes from the constructor param assigned to it. Inferred
  // before routing, which would hand the param entries to CST and the field
  // to the pass-through, so neither side saw both.
  const fieldEntries = inferClassFieldTypes(source, typeInfo);
  if (fieldEntries.length > 0) typeInfo = [...typeInfo, ...fieldEntries];

  const { eligible: deduped, passThrough } = routeEntries(typeInfo, cstIndex, infer, telemetry);

  // --- Build CST replacements ---

  const ctx: CstApplyContext = {
    infer,
    prefix,
    program,
    verify: options.verify,
    telemetry,
    namedTypeIndex,
    scopedTypeNames,
    ctorArityMap,
    checkerIndex,
    source,
    filename: options.filename,
  };

  // Redundancy is judged against the file as apply leaves it, not as it was
  // on disk. A local initialised from a call to an untyped function infers
  // `any` until the callee has its signature, and the same run is writing that
  // signature. So the signatures go first, and the sites whose inference
  // depends on them — locals, class fields, and the parameters and return of a
  // callback, which the typed outer call now types contextually — are judged
  // in a second pass against a program holding the first. That program is the
  // verify context's; without one the file is applied in one pass, as before.
  const verify = options.verify;
  const { signatures, dependents } = verify
    ? splitByDependency(deduped, cstIndex)
    : { signatures: deduped, dependents: new Map<string, RoutedEntry>() };

  const firstReplacements = buildCstReplacements(signatures, cstIndex, ctx);
  const afterFirst = applyReplacements(source, firstReplacements);
  const throughFirst = rebaser(firstReplacements);
  let afterCst = afterFirst;
  let throughCst = throughFirst;

  if (verify && dependents.size > 0) {
    advanceCurrentSource(verify, afterFirst);
    const secondProgram = verify.project.service.getProgram() ?? program;
    const secondIndex = buildCstSiteIndex(parseDetached(afterFirst), afterFirst, infer);
    // Sites keep their kind from the first routing; only their offsets moved.
    // One that no longer resolves goes to the offset applier with the rest.
    const originalPos = new Map<number, number>();
    const moved = new Map<string, RoutedEntry>();
    for (const [key, routed] of dependents) {
      const [file, pos, types, opts] = routed.entry;
      const newPos = throughFirst(pos);
      if (!hasSite(secondIndex, routed.kind, newPos)) {
        passThrough.push(routed.entry);
        continue;
      }
      originalPos.set(newPos, pos);
      moved.set(key, { kind: routed.kind, entry: [file, newPos, types, opts] });
    }
    const skippedBefore = telemetry?.skipped.length ?? 0;
    // The names in scope are read again from the file as the first pass left
    // it, so a type that pass declared is one the second can write.
    const secondScoped = scopedTypeNamesFor(afterFirst, secondProgram, options.filename, infer);
    const secondReplacements = buildCstReplacements(moved, secondIndex, {
      ...ctx,
      program: secondProgram,
      checkerIndex: buildCheckerSiteIndex(secondProgram, options.filename, afterFirst, infer),
      scopedTypeNames: secondScoped,
      namedTypeIndex: infer.preferNamedInScope
        ? buildNamedTypeIndex(afterFirst, secondProgram, options.filename, secondScoped)
        : undefined,
      source: afterFirst,
      stripNotes: false,
    });
    // The report locates a skip in the source the caller handed over.
    for (const skip of telemetry?.skipped.slice(skippedBefore) ?? []) {
      skip.pos = originalPos.get(skip.pos) ?? skip.pos;
    }
    afterCst = applyReplacements(afterFirst, secondReplacements);
    const throughSecond = rebaser(secondReplacements);
    throughCst = (pos) => throughSecond(throughFirst(pos));
  }

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

  // --- Rebase pass-through offsets through the CST passes ---
  //
  // Each pass-through entry's `pos` is relative to the original source; to
  // splice into `afterCst` it moves through every edit the CST passes made.
  const rebaseOffset = throughCst;

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
        redundant: 0,
        skipped: [],
      }
    : undefined;
  // Invert the rebasing so the delegate can look sites up by their original
  // offset. Built from the same pairs the rebase produced, so the two cannot
  // drift apart.
  const originalPosByRebased = new Map<number, number>();
  for (const [, pos] of passThrough) originalPosByRebased.set(rebaseOffset(pos), pos);

  const innerOptions = {
    ...options,
    ...(sub ? { telemetry: sub } : {}),
    ...(checkerIndex
      ? {
          checkerSites: {
            index: checkerIndex,
            toOriginalPos: (p: number) => originalPosByRebased.get(p) ?? p,
          },
        }
      : {}),
    // This pass already stripped, and `afterCst` holds the notes it wrote.
    stripConflictNotes: false,
    inferClassFields: false,
  };
  const result = applyTypesToFile(afterCst, rebasedPassThrough, innerOptions, program);
  if (telemetry && sub) {
    telemetry.emitted += sub.emitted;
    telemetry.idempotent += sub.idempotent;
    telemetry.unparseable += sub.unparseable;
    telemetry.positionMismatch += sub.positionMismatch;
    telemetry.verifyReject += sub.verifyReject;
    telemetry.redundant += sub.redundant;
    for (const skipped of sub.skipped) {
      telemetry.skipped.push({
        ...skipped,
        pos: originalPosByRebased.get(skipped.pos) ?? skipped.pos,
      });
    }
  }
  return result;
}

/**
 * The type names the file can reach, for the scope check (mirrored from the
 * offset path). From the TypeChecker when a Program holds the file, else from
 * the text.
 */
function scopedTypeNamesFor(
  source: string,
  program: ts.Program | undefined,
  filename: string | undefined,
  infer: InferOptions,
): Set<string> | undefined {
  if (!infer.requireTypeRefInScope) return undefined;
  if (program && filename) {
    const fromTC = buildScopedTypeNamesViaTypeChecker(program, filename);
    if (fromTC) return fromTC;
  }
  return buildScopedTypeNames(source, filename);
}

function parseDetached(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "__ts-capture_apply_cst.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
}

/**
 * The sites whose annotation other sites' inference depends on, and the sites
 * that depend on them: every local and class field, and every site on a
 * function passed as an argument, since the call it is passed to types it
 * contextually once the callee's own parameters are written.
 */
function splitByDependency(
  eligible: Map<string, RoutedEntry>,
  index: CstSiteIndex,
): { signatures: Map<string, RoutedEntry>; dependents: Map<string, RoutedEntry> } {
  const signatures = new Map<string, RoutedEntry>();
  const dependents = new Map<string, RoutedEntry>();
  for (const [key, routed] of eligible) {
    const fn = functionOfSite(index, routed);
    const dependent = routed.kind === "varDecl" || (fn !== undefined && isCallbackArgument(fn));
    (dependent ? dependents : signatures).set(key, routed);
  }
  return { signatures, dependents };
}

function functionOfSite(index: CstSiteIndex, routed: RoutedEntry): ts.Node | undefined {
  const pos = routed.entry[1];
  if (routed.kind === "param") return index.paramSites.get(pos)?.node.parent;
  if (routed.kind === "returnType") return index.returnTypeSites.get(pos)?.node;
  if (routed.kind === "thisType") return index.thisTypeSites.get(pos)?.node;
  return undefined;
}

function isCallbackArgument(fn: ts.Node): boolean {
  let node: ts.Node = fn;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) return false;
  return parent.arguments?.some((arg) => arg === node) ?? false;
}

function hasSite(index: CstSiteIndex, kind: RoutedEntry["kind"], pos: number): boolean {
  if (kind === "param") return index.paramSites.has(pos);
  if (kind === "returnType") return index.returnTypeSites.has(pos);
  if (kind === "thisType") return index.thisTypeSites.has(pos);
  return index.varDeclSites.has(pos);
}

/**
 * Maps an offset in the text before `replacements` to the same point after
 * them. An edit moves a position only when it lies entirely before it, so an
 * insertion at the position itself leaves it where it is: text inserted there
 * belongs to the site, and the position is where the next insertion lands.
 */
function rebaser(replacements: readonly Replacement[]): (pos: number) => number {
  const edits = replacements
    .map((r) => ({ start: r.start, end: r.end, delta: r.text.length - (r.end - r.start) }))
    .sort((a, b) => a.start - b.start);
  return (pos) => {
    let shift = 0;
    for (const edit of edits) {
      if (edit.start >= pos) break;
      if (edit.end <= pos) shift += edit.delta;
    }
    return pos + shift;
  };
}
