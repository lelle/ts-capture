import ts from "typescript";

import type { ApplyTypesOptions } from "./contract.js";
import type { RoutedEntry } from "./cst-routing.js";
import type { CstSiteIndex } from "./cst-site-index.js";
import type { CollectedTypeInfo } from "./type-collector.js";

import { advanceCurrentSource } from "./apply-types-verify.js";
import { inferClassFieldTypes } from "./class-field-inference.js";
import { INFER_DEFAULTS, type InferOptions } from "./configuration.js";
import { markerLineRanges, markerSpanRanges } from "./conflict-comment.js";
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
 * The applier behind `annotate`. Sites come from the AST, so a stale
 * offset cannot put a type at the wrong site, and idempotency is part
 * of the same pass. An entry whose position is no site in the AST is a
 * `no-site` skip.
 *
 * Scope:
 *
 * - **Sites**:
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
 *     required from the producer side, so dump files missing the flag
 *     still produce correct output.
 * Edits are emitted as string replacements at AST-derived offsets, NOT
 * via the TS printer.
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

  const sf = parseDetached(source, options.filename);

  // --- Build AST-site indices ---

  const cstIndex = buildCstSiteIndex(sf, source, infer);

  // A second index over the *Program's* SourceFile, keyed identically: `sf`
  // above is detached, and the checker cannot answer about its nodes.
  const checkerIndex = buildCheckerSiteIndex(program, options.filename, source, infer);
  const telemetry = options.telemetry;

  // --- Route entries to their sites ---

  typeInfo = shiftPastNotes(typeInfo, source, cstIndex);

  // A field's type comes from the constructor param assigned to it, so it is
  // inferred before routing, from the param entries.
  const fieldEntries = inferClassFieldTypes(source, typeInfo);
  if (fieldEntries.length > 0) typeInfo = [...typeInfo, ...fieldEntries];

  const { eligible: deduped } = routeEntries(typeInfo, cstIndex, infer, telemetry);

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

  if (verify && dependents.size > 0) {
    advanceCurrentSource(verify, afterFirst);
    const secondProgram = verify.project.service.getProgram() ?? program;
    const secondIndex = buildCstSiteIndex(
      parseDetached(afterFirst, options.filename),
      afterFirst,
      infer,
    );
    // Sites keep their kind from the first routing; only their offsets moved.
    const originalPos = new Map<number, number>();
    const moved = new Map<string, RoutedEntry>();
    for (const [key, routed] of dependents) {
      const [file, pos, types, opts] = routed.entry;
      const newPos = throughFirst(pos);
      if (!hasSite(secondIndex, routed.kind, newPos)) {
        if (telemetry) {
          telemetry.positionMismatch++;
          telemetry.skipped.push({
            pos,
            reason: "no-site",
            observed: [...new Set(types.map(([name]) => name).filter(Boolean))].join(" | "),
          });
        }
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
  }

  return afterCst;
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

/** In the file's own dialect: read as plain TypeScript, JSX turns into error recovery. */
function parseDetached(source: string, filename: string | undefined): ts.SourceFile {
  const jsx = filename !== undefined && /\.[jt]sx$/.test(filename);
  return ts.createSourceFile(
    jsx ? "__ts-capture_apply_cst.tsx" : "__ts-capture_apply_cst.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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

/**
 * A preview writes its notes into the file, and the apply after it reads
 * observations made before them. An entry that lands on no site is moved past
 * the notes in front of it, and kept there when that is a site. One collected
 * from the file with its notes already lands on its site and stays.
 */
function shiftPastNotes(
  typeInfo: CollectedTypeInfo,
  source: string,
  index: CstSiteIndex,
): CollectedTypeInfo {
  const notes = [...markerLineRanges(source), ...markerSpanRanges(source)].sort(
    (a, b) => a[0] - b[0],
  );
  if (notes.length === 0) return typeInfo;
  const placed = (kind: RoutedEntry["kind"], pos: number): boolean =>
    hasSite(index, kind, pos) || (kind === "param" && index.typedParamEnds.has(pos));
  return typeInfo.map((e) => {
    const [file, pos, types, opts] = e;
    const kind = opts?.thisType
      ? "thisType"
      : opts?.varDecl
        ? "varDecl"
        : opts?.returnType
          ? "returnType"
          : "param";
    if (placed(kind, pos)) return e;
    let shifted = pos;
    for (const [start, end] of notes) {
      if (start >= shifted) break;
      shifted += end - start;
    }
    return placed(kind, shifted) ? [file, shifted, types, opts] : e;
  });
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
