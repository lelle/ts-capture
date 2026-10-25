import ts from "typescript";

import type { InferOptions } from "./configuration.js";
import type { RoutedEntry } from "./cst-routing.js";
import type { CstSiteIndex } from "./cst-site-index.js";

import { suppressArrayCallbackStructural } from "./annotation-eligibility.js";
import { buildDiagnosticMarkerSuffix } from "./apply-diagnostics.js";
import {
  explainRejection,
  filterAcceptedReplacements,
  type SupportingReplacements,
  type VerificationContext,
  widerTypeWithOthers,
  wouldIntroduceErrors,
} from "./apply-types-verify.js";
import { checkerGate } from "./checker-gate.js";
import { carriesNoInformation, computeAnnotation } from "./compute-annotation.js";
import {
  addNote,
  type ConflictNote,
  isInsideTextRun,
  markerLineRanges,
  markerSpanRanges,
  type NoteBucket,
  noteReplacements,
  parseForNoteSafety,
  type PreviewNote,
  type SiteKind,
  siteName,
  siteNameAt,
} from "./conflict-comment.js";
import { type ApplyRule, type ApplyTelemetry, REASON_OF, type SkipRule } from "./contract.js";
import {
  hasConstAssertion,
  inferTypeFromInitializer,
  isSymbolCall,
} from "./initializer-inference.js";
import { type NamedTypeIndex, rewriteToNamedInScope } from "./named-type-rewrite.js";
import { narrowParamShape } from "./param-shape-narrowing.js";
import { isParseableTypeString } from "./parseable.js";
import {
  describeInferred,
  inferredReturnType,
  inferredThisType,
  typeAt,
} from "./redundant-annotation.js";
import { Replacement } from "./replacement.js";
import { expandCtorArity, unreachableTypeRefs } from "./scope-reachability.js";
import { planShapeAliases } from "./shape-aliases.js";
import { canonicalTypeString, sameTypeString, typeStringForSource } from "./type-canonical.js";

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
  /** The file's text, for line starts and for finding apply's own notes. */
  source?: string;
  /** The file's name, which decides the dialect the note-safety parse uses. */
  filename?: string;
  /**
   * Whether this pass removes the notes already in `source`. False for a second
   * pass over the same file: the first pass stripped, and `source` now holds
   * the notes it wrote.
   */
  stripNotes?: boolean;
}

/**
 * Build the CST-anchored replacement list from the deduped eligible entries.
 * Structural inserts (paren wraps, `this:` separators) go in unconditionally;
 * annotation text is buffered and gated through a single batch verify pass when
 * `ctx.verify` is set.
 */
/** The site kinds the checker gate is asked about. */
type GateKind = SiteKind | "thisType";

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
    source,
    filename,
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
  // Contradictions between the run and the checker, grouped by the line they
  // sit on: one line can hold several sites, and their notes stack above it.
  const conflictNotes = new Map<number, NoteBucket<ConflictNote>>();
  // What apply would have written, for the preview modes.
  const previewNotes = new Map<number, NoteBucket<PreviewNote>>();
  const pendingPreviews = new Map<number, PreviewNote>();
  // The checker's view at the site currently being decided, so the preview can
  // report it without every branch threading it through.
  let lastInferredString: string | undefined;

  /**
   * Write down a contradiction `checkerGate` found — see `conflict-comment.ts`
   * for why apply reports rather than fixes.
   *
   * Placement can still fail, and the caller skips the site either way: a
   * contradiction apply cannot report is still a contradiction.
   */
  function placeNote(
    pos: number,
    kind: SiteKind,
    node: ts.Node | undefined,
    inferred: string | undefined,
    observed: string[],
  ): void {
    if (!infer.emitConflictComments) return;
    if (!node || inferred === undefined || source === undefined) return;
    // No leading-line check here: `noteReplacements` is the one place that
    // knows whether this note ends up above the line or at the site, and only
    // the first of those cares what the line starts inside.
    addNote(conflictNotes, source, pos, {
      name: siteName(kind, node, node.getSourceFile()),
      observed,
      inferred,
    });
  }

  /** The node the checker resolved for a site, by the index its kind lives in. */
  function checkerNodeAt(kind: GateKind, pos: number): ts.Node | undefined {
    if (kind === "param") return checkerIndex?.paramSites.get(pos)?.node;
    if (kind === "returnType") return checkerIndex?.returnTypeSites.get(pos)?.node;
    if (kind === "thisType") return checkerIndex?.thisTypeSites.get(pos)?.node;
    return checkerIndex?.varDeclSites.get(pos)?.nameNode?.parent;
  }

  /**
   * Ask the checker whether this annotation is worth writing, and act on the
   * answer. False means the site is settled and the caller moves on.
   *
   * One place for the response, for the same reason `checker-gate.ts` gives for
   * the rule order: the site kinds differ only in which index resolves the
   * node, and a verdict acted on in one branch and not another is invisible.
   */
  function gateAllows(
    pos: number,
    kind: GateKind,
    inferred: ts.Type | undefined,
    emitted: string,
  ): boolean {
    const verdict = checkerGate(checker, inferred, emitted, infer, checkerNodeAt(kind, pos));
    if (verdict.kind === "contradiction") {
      // A `this` slot has no identifier to name, so its note is placed under
      // the name `siteNameAt` gives it rather than a declaration's own.
      const named = kind === "thisType" ? "param" : kind;
      placeNote(pos, named, checkerNodeAt(kind, pos), lastInferredString, verdict.observed);
      skip("gate.contradiction", lastInferredString && `the type here is ${lastInferredString}`);
      return false;
    }
    if (verdict.kind === "redundant") {
      if (telemetry) {
        telemetry.idempotent++;
        telemetry.redundant++;
      }
      skip("gate.redundant");
      return false;
    }
    if (verdict.kind === "suppress") {
      skip(verdict.rule, lastInferredString && `TypeScript has ${lastInferredString}`);
      return false;
    }
    return true;
  }

  /**
   * Re-check the FINAL string: `rewriteToNamedInScope` and `expandCtorArity`
   * run after `computeAnnotationTypeString`, and arity expansion in particular
   * turns a keepable bare `Container` into `Container<unknown>`, which
   * describes no payload.
   */
  const describesNothing = (emitted: string): boolean =>
    !infer.emitDiagnosticComments && carriesNoInformation(emitted);
  // Parsed once, and only when a note is actually about to be placed: a line
  // start inside a template literal or JSX text is inside *text*, and a comment
  // written there becomes part of it.
  let noteSafetySf: ts.SourceFile | undefined;
  function canPlaceNoteAt(lineStart: number): boolean {
    if (source === undefined) return false;
    noteSafetySf ??= parseForNoteSafety(filename, source);
    return !isInsideTextRun(noteSafetySf, lineStart);
  }
  // Every annotation the loop decides to write, settled after it.
  const buffered: Array<{
    pos: number;
    emitted: string;
    wrap: (type: string) => string;
    name?: string;
    priority?: number;
    /** For a return type: what TypeScript inferred there before the run. */
    returnType?: { inferredBefore?: string };
  }> = [];

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

  // Names come from the detached index, which exists whether or not a project
  // does — a note that cannot say which position it means is a note a reader
  // cannot follow.
  const nameAt = (kind: SiteKind, pos: number): string => siteNameAt(index, kind, pos, source);

  /**
   * Note what would be written here, pending acceptance.
   *
   * Held by position rather than written straight out: a candidate can still
   * be rejected by the batch verify pass, and a preview promising an
   * annotation that would never land is not a preview. `settlePreview` moves
   * it across once the annotation is accepted.
   */
  function recordPreview(
    pos: number,
    name: string,
    suggestion: string,
    observations: number,
  ): void {
    if (infer.outputMode === "annotations" || source === undefined) return;
    pendingPreviews.set(pos, { name, suggestion, observations, inferred: lastInferredString });
  }

  /**
   * Move an accepted site's preview into place — above the line, or at the site
   * when the line holds more than one.
   */
  function settlePreview(pos: number): void {
    const note = pendingPreviews.get(pos);
    if (!note || source === undefined) return;
    addNote(previewNotes, source, pos, note);
  }

  /**
   * Hold an annotation until the end of the pass. Every site is decided
   * together: the shapes they repeat are named across them, and the verify
   * pass judges them as a batch. Comments mode holds too, so verify still gets
   * to reject: the preview has to agree with what an ordinary apply would do.
   */
  function bufferAnnotation(
    pos: number,
    emitted: string,
    wrap: (type: string) => string,
    name?: string,
    priority?: number,
    returnType?: { inferredBefore?: string },
  ): void {
    buffered.push({ pos, emitted, wrap, name, priority, returnType });
    observedByCandidatePos.set(pos, currentObserved);
  }

  // What the report says about a site that gets nothing. Set per entry, so a
  // drop anywhere below is recorded against the site it belongs to.
  let currentPos = 0;
  let currentObserved = "";
  const observedByCandidatePos = new Map<number, string>();
  function skip(rule: SkipRule, detail?: string): void {
    telemetry?.skipped.push({
      pos: currentPos,
      reason: REASON_OF[rule],
      rule,
      observed: currentObserved,
      ...(detail ? { detail } : {}),
    });
  }
  /** Records the drop and answers true when the annotation names a type out of reach. */
  function outOfScope(emitted: string): boolean {
    const missing = unreachableTypeRefs(emitted, scopedTypeNames);
    if (missing.length === 0) return false;
    skip(
      "info.out-of-scope",
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in scope`,
    );
    return true;
  }

  /** The text written at a site for a type, in source punctuation. */
  const annotation =
    (suffix: string, lead = ": ") =>
    (type: string): string =>
      lead + prefix + (typeStringForSource(type) ?? type) + suffix;

  for (const { entry, kind } of eligible.values()) {
    // Each site answers for itself. This is one variable shared by every
    // branch, and a value left over from the previous entry names a different
    // position — a note that gets that wrong is worse than one that omits it.
    lastInferredString = undefined;
    const [, pos, types, opts] = entry;
    currentPos = pos;
    currentObserved = [...new Set(types.map(([name]) => name).filter(Boolean))].join(" | ");
    // Shared marker-comment suffix; appended after the type and before
    // any structural suffix (`)` for paren-less arrow wrap, `, ` for
    // thisType-with-other-params).
    const markerSuffix = buildDiagnosticMarkerSuffix(types, infer);

    if (kind === "param") {
      // No call passed it. `: undefined` would make every call that does a
      // type error, and says nothing about what the parameter is for.
      if (types.every(([name]) => name === "undefined")) {
        skip("info.never-passed", "every call left it out");
        continue;
      }
      const site = paramSites.get(pos)!;
      const isOptional = !!site.node.questionToken;
      const computed = computeAnnotation(types, opts, infer, isOptional, program);
      if (typeof computed !== "string") {
        skip(computed.rule);
        continue;
      }
      // The contract first: a shape that is an in-scope type in full is that
      // type. What is left structural is cut to what the body reads, and may
      // then be a smaller in-scope type.
      const named = rewriteToNamedInScope(computed, namedTypeIndex);
      const narrowed = infer.narrowParamShapes ? narrowParamShape(named, site.node) : named;
      const shaped = narrowed === named ? named : rewriteToNamedInScope(narrowed, namedTypeIndex);
      const emitted = ctorArityMap
        ? expandCtorArity(shaped, ctorArityMap, opts?.writtenParamTypes)
        : shaped;
      if (outOfScope(emitted)) {
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
      //
      // Only when the receiver has an element type to give. On an untyped one
      // the checker has `any` here and the observation is all there is. A
      // reduce accumulator is no element, and is skipped either way.
      const paramNode = checkerIndex?.paramSites.get(pos)?.node;
      const inferredParam = typeAt(checker, paramNode?.name);
      const leftAsAny =
        inferredParam !== undefined &&
        (inferredParam.flags & ts.TypeFlags.Any) !== 0 &&
        !isReduceAccumulator(paramNode);
      if (
        opts?.arrow &&
        !leftAsAny &&
        suppressArrayCallbackStructural(arrayCallbackArrowParams.has(pos), emitted)
      ) {
        if (site.parensOpenPos !== undefined) {
          requestParenWrap(site.parensOpenPos, pos);
        }
        skip("syntax.array-callback-shape");
        continue;
      }
      // Parse-check — refuse to write an unparseable type.
      if (!isParseableTypeString(emitted)) {
        skip("info.unparseable", "not a type TypeScript can parse");
        continue;
      }
      if (describesNothing(emitted)) {
        skip("info.describes-nothing");
        continue;
      }
      // Nothing to add when the checker already types this parameter — a
      // contextually typed callback param, for instance.
      lastInferredString = describeInferred(checker, inferredParam);
      if (!gateAllows(pos, "param", inferredParam, emitted)) continue;
      // Paren-less single-param arrow: wrap with `()` separately so the
      // annotation can be gated through verify independently. Wrap
      // pushes unconditionally — if verify rejects the annotation,
      // `(x) => body` stays as harmless valid syntax. Priority scheme:
      // `)` priority 0, param annotation priority 1 — sorts so the
      // annotation lands BEFORE the `)` in the output, yielding
      // `(x: T) => body`.
      const paramName = ts.isIdentifier(site.node.name) ? site.node.name.text : undefined;
      if (site.parensOpenPos !== undefined) {
        requestParenWrap(site.parensOpenPos, pos);
        recordPreview(pos, nameAt("param", pos), emitted, types.length);
        bufferAnnotation(pos, emitted, annotation(markerSuffix), paramName, 1);
      } else {
        recordPreview(pos, nameAt("param", pos), emitted, types.length);
        bufferAnnotation(pos, emitted, annotation(markerSuffix), paramName);
      }
    } else if (kind === "thisType") {
      const site = thisTypeSites.get(pos)!;
      const computed = computeAnnotation(types, opts, infer, false, program);
      if (typeof computed !== "string") {
        skip(computed.rule);
        continue;
      }
      const named = rewriteToNamedInScope(computed, namedTypeIndex);
      const emitted = ctorArityMap
        ? expandCtorArity(named, ctorArityMap, opts?.writtenParamTypes)
        : named;
      if (outOfScope(emitted)) continue;
      // Parse-check.
      if (!isParseableTypeString(emitted)) {
        skip("info.unparseable", "not a type TypeScript can parse");
        continue;
      }
      if (describesNothing(emitted)) {
        skip("info.describes-nothing");
        continue;
      }
      // When the function already has params, `this: T` needs a
      // separator before the first one.
      const suffix = site.hasOtherParams ? ", " : "";
      // `this` was the one site kind the gate never covered — and the only one
      // whose whole subject is `this`. In a class method the checker already
      // types it polymorphically, so writing the class the run saw costs every
      // subclass its own.
      const inferredThis = inferredThisType(checker, checkerIndex?.thisTypeSites.get(pos)?.node);
      lastInferredString = describeInferred(checker, inferredThis);
      if (!gateAllows(pos, "thisType", inferredThis, emitted)) continue;
      recordPreview(pos, "this", emitted, types.length);
      bufferAnnotation(pos, emitted, annotation(markerSuffix + suffix, "this: "));
    } else if (kind === "returnType") {
      const computed = computeAnnotation(types, opts, infer, false, program);
      if (typeof computed !== "string") {
        skip(computed.rule);
        continue;
      }
      const named = rewriteToNamedInScope(computed, namedTypeIndex);
      const emitted = ctorArityMap
        ? expandCtorArity(named, ctorArityMap, opts?.writtenParamTypes)
        : named;
      if (outOfScope(emitted)) continue;
      // Same suppression as for arrow-param entries —
      // when the returnType lands on an Array.prototype callback's
      // arrow AND emitted is a structural shape, TS contextually types
      // the callback's return from the array's element type. Skip.
      if (suppressArrayCallbackStructural(arrayCallbackArrowParams.has(pos), emitted)) {
        skip("syntax.array-callback-shape");
        continue;
      }
      const returnSite = checkerIndex?.returnTypeSites.get(pos)?.node;
      const inferredReturn = inferredReturnType(checker, returnSite);
      lastInferredString = describeInferred(checker, inferredReturn);

      // `this` has no single value to write down. Any concrete type here —
      // however well observed — costs every subclass its own return type.
      if (!gateAllows(pos, "returnType", inferredReturn, emitted)) continue;
      // Lower priority than param inserts: on a paren-less arrow both
      // land at the same pos, and the param goes first.
      // Parse-check.
      if (!isParseableTypeString(emitted)) {
        skip("info.unparseable", "not a type TypeScript can parse");
        continue;
      }
      if (describesNothing(emitted)) {
        skip("info.describes-nothing");
        continue;
      }
      // A paren-less arrow's parameter entry may be skipped or missing before
      // it asks for the parens; the return still needs them.
      const parensOpenPos = paramSites.get(pos)?.parensOpenPos;
      if (parensOpenPos !== undefined) requestParenWrap(parensOpenPos, pos);
      recordPreview(pos, nameAt("returnType", pos), emitted, types.length);
      // Read from the site, as the type it is compared with later is.
      bufferAnnotation(pos, emitted, annotation(markerSuffix), undefined, -1, {
        inferredBefore: describeInferred(checker, inferredReturn, returnSite),
      });
    } else {
      // varDecl: user-written `as Type` / `<Type>` cast on RHS — defer
      // to the cast unless honorAsCasts is explicitly off.
      if (opts?.hasAsCast && infer.honorAsCasts) {
        skip("syntax.as-cast", "the initializer has an `as` cast");
        continue;
      }
      const site = varDeclSites.get(pos)!;
      const computed = computeAnnotation(types, opts, infer, false, program);
      if (typeof computed !== "string") {
        skip(computed.rule);
        continue;
      }
      const named = rewriteToNamedInScope(computed, namedTypeIndex);
      const emitted = ctorArityMap
        ? expandCtorArity(named, ctorArityMap, opts?.writtenParamTypes)
        : named;
      if (outOfScope(emitted)) continue;
      // A const assertion is a narrowing the author asked for, and an
      // observation can only widen it. Unconditional, unlike
      // `skipRedundantAnnotations` below: asking for redundant annotations is
      // asking for restatement, not for destruction.
      if (site.initializer && hasConstAssertion(site.initializer)) {
        skip("syntax.as-const", "the initializer is `as const`");
        continue;
      }
      // A `unique symbol` is the same narrowing, inferred rather than
      // asked for: widening it to `symbol` is destruction, not
      // restatement, so it does not wait for the flag either.
      if (emitted === "symbol" && site.initializer && isSymbolCall(site.initializer)) {
        skip("syntax.unique-symbol", "a `unique symbol` would be widened");
        continue;
      }
      const inferredBinding = typeAt(checker, checkerIndex?.varDeclSites.get(pos)?.nameNode);
      lastInferredString = describeInferred(checker, inferredBinding);
      // `const self = this` — the same erasure as on a return type, in a
      // binding. nest aliases `this` that way so a class expression can close
      // over it.
      // The checker answers redundancy exactly and for every initializer shape.
      // The syntactic table below is the fallback for runs with no project
      // (`getProgram` returns undefined without a tsconfig).
      if (!gateAllows(pos, "varDecl", inferredBinding, emitted)) continue;
      if (infer.skipRedundantAnnotations && site.initializer) {
        const inferredFromSource = inferTypeFromInitializer(site.initializer, site.narrowsLiterals);
        if (inferredFromSource !== null && inferredFromSource === emitted) {
          skip("syntax.redundant-initializer");
          continue;
        }
      }
      // Parse-check.
      if (!isParseableTypeString(emitted)) {
        skip("info.unparseable", "not a type TypeScript can parse");
        continue;
      }
      if (describesNothing(emitted)) {
        skip("info.describes-nothing");
        continue;
      }
      recordPreview(pos, nameAt("varDecl", pos), emitted, types.length);
      const bindingName =
        site.nameNode && ts.isIdentifier(site.nameNode) ? site.nameNode.text : undefined;
      bufferAnnotation(pos, emitted, annotation(markerSuffix), bindingName);
    }
  }

  // A shape several annotations spell out is declared once and named at each
  // of them. Decided over the whole pass, before verify: the declaration goes
  // into every probe that names it, and into the file only if a named
  // annotation is written.
  const declarations: Array<{ name: string; text: string; names: RegExp }> = [];
  let declarationsAt: { pos: number; render: (text: string) => string } | undefined;
  if (infer.aliasRepeatedShapes && buffered.length > 0 && source !== undefined) {
    const nameTaken = (name: string): boolean =>
      (scopedTypeNames?.has(name) ?? false) || new RegExp(`\\b${name}\\b`).test(source);
    const plan = planShapeAliases(buffered, nameTaken);
    buffered.forEach((candidate, i) => {
      candidate.emitted = plan.emitted[i];
    });
    noteSafetySf ??= parseForNoteSafety(filename, source);
    declarationsAt = declarationSite(noteSafetySf);
    for (const { name, body } of plan.declarations) {
      declarations.push({
        name,
        text: `type ${name} = ${body};`,
        names: new RegExp(`\\b${name}\\b`),
      });
    }
  }
  // A declaration names the shapes it holds, so one that is needed brings
  // those with it, however far in they sit.
  const declarationsNamedIn = (texts: readonly string[]): string[] => {
    const needed = new Set<(typeof declarations)[number]>();
    let naming = texts;
    while (naming.length > 0) {
      const found = declarations.filter(
        (d) => !needed.has(d) && naming.some((text) => d.names.test(text)),
      );
      for (const declaration of found) needed.add(declaration);
      naming = found.map((d) => d.text.slice(d.text.indexOf("=")));
    }
    return declarations.filter((d) => needed.has(d)).map((d) => d.text);
  };

  const texts = buffered.map((candidate) => candidate.wrap(candidate.emitted));
  // A candidate verify replaced with TypeScript's type, by index.
  const writtenAs = new Map<number, { rule: ApplyRule; type: string }>();
  let accepted = buffered.map((_, i) => i);

  // Batch verify pass for the CST applier. Buffered
  // annotation candidates are probed in one shot (fast path: all-or-
  // nothing). If the batch introduces new diagnostics, bisect /
  // greedy fallback inside `filterAcceptedReplacements` picks the
  // largest safe subset. Only accepted candidates push their
  // insertion into `cstReplacements`; structural paren wraps already
  // pushed above stay regardless of verify outcome.
  if (verify && buffered.length > 0) {
    const probes = buffered.map((c, i) => ({ start: c.pos, end: c.pos, text: texts[i] }));
    const supporting: SupportingReplacements | undefined = declarationsAt
      ? (subset) => {
          const needed = declarationsNamedIn(subset.map((p) => p.text));
          if (needed.length === 0) return [];
          const at = declarationsAt!;
          return [{ start: at.pos, end: at.pos, text: needed.map(at.render).join("") }];
        }
      : undefined;
    accepted = filterAcceptedReplacements(verify, probes, supporting);
    const acceptedSet = new Set(accepted);
    const acceptedProbes = accepted.map((i) => probes[i]);
    const introducesErrors = (subset: typeof probes): boolean =>
      wouldIntroduceErrors(verify, [...(supporting?.(subset) ?? []), ...subset]);
    buffered.forEach((candidate, i) => {
      if (acceptedSet.has(i)) return;
      const observed = observedByCandidatePos.get(candidate.pos) ?? "";
      // Judged before the file's other annotations existed; with them
      // written, TypeScript may infer a type that holds what the run saw.
      const wider = widerTypeWithOthers(
        verify,
        acceptedProbes,
        probes[i],
        candidate.emitted,
        supporting,
      );
      if (wider !== undefined) {
        // A function's return type is written even where TypeScript could
        // infer it, once the run's annotations made the inference. The run
        // missed some of what it can return, so the type written is TypeScript's,
        // spelled as apply spells its own. One TypeScript inferred before the run
        // is a restatement, written only when restatements are asked for.
        const { returnType } = candidate;
        const spelled = typeStringForSource(canonicalTypeString(wider) ?? wider) ?? wider;
        const probe = { ...probes[i], text: candidate.wrap(spelled) };
        const knownBefore =
          returnType?.inferredBefore !== undefined &&
          sameTypeString(returnType.inferredBefore, wider);
        if (
          returnType &&
          !(knownBefore && infer.skipRedundantAnnotations) &&
          unreachableTypeRefs(wider, scopedTypeNames).length === 0 &&
          !introducesErrors([...acceptedProbes, probe])
        ) {
          texts[i] = probe.text;
          accepted.push(i);
          acceptedProbes.push(probe);
          writtenAs.set(i, { rule: "verify.wider-after-run", type: spelled });
          return;
        }
        telemetry?.skipped.push({
          pos: candidate.pos,
          reason: "left-to-typescript",
          rule: "verify.wider-after-run",
          observed,
          detail: "TypeScript infers a wider type once the other annotations are written",
        });
        return;
      }
      if (telemetry) {
        telemetry.verifyReject++;
        const diagnostic = explainRejection(verify, probes[i], supporting);
        telemetry.skipped.push({
          pos: candidate.pos,
          reason: "type-error",
          rule: "verify.type-error",
          observed,
          ...(diagnostic
            ? { diagnostic }
            : { detail: "type-checks alone, but not with the other annotations in this file" }),
        });
      }
    });
  }

  const written: string[] = [];
  for (const i of accepted) {
    const candidate = buffered[i];
    settlePreview(candidate.pos);
    if (infer.outputMode === "comments") continue;
    cstReplacements.push(Replacement.insert(candidate.pos, texts[i], candidate.priority ?? 0));
    annotatedPositions.add(candidate.pos);
    written.push(texts[i]);
    if (telemetry) {
      telemetry.emitted++;
      telemetry.written?.push({
        pos: candidate.pos,
        ...(writtenAs.get(i) ?? {
          rule: "written",
          type: typeStringForSource(candidate.emitted) ?? candidate.emitted,
        }),
      });
    }
  }
  if (declarationsAt) {
    const needed = declarationsNamedIn(written);
    if (needed.length > 0) {
      const at = declarationsAt;
      cstReplacements.push(Replacement.insert(at.pos, needed.map(at.render).join("")));
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

  // Apply owns every note in the file: the ones it finds go, and the ones that
  // hold now are written. Both are replacements against the original source, so
  // removing and inserting cannot shift each other's offsets.
  //
  // Unconditional, because the marker namespace is apply's whichever flag put
  // a note there. Gated on `emitConflictComments`, a run writing preview notes
  // under `outputMode` with conflict notes off took nothing away and stacked a
  // fresh copy above the line on every pass.
  if (source !== undefined && ctx.stripNotes !== false) {
    for (const [start, end] of markerLineRanges(source)) {
      cstReplacements.push(Replacement.delete(start, end));
    }
    for (const [start, end] of markerSpanRanges(source)) {
      cstReplacements.push(Replacement.delete(start, end));
    }
  }

  cstReplacements.push(
    ...noteReplacements({
      conflictNotes,
      previewNotes,
      outputMode: infer.outputMode,
      canPlaceNoteAt,
    }),
  );

  return cstReplacements;
}

/**
 * Where a file's own type declarations go: after its last import, or at the
 * top, past a shebang. Each declaration renders with the blank line a reader
 * expects around it there.
 */
/** The first parameter of a callback passed to `reduce` or `reduceRight`. */
function isReduceAccumulator(param: ts.ParameterDeclaration | undefined): boolean {
  const callback = param?.parent;
  const call = callback?.parent;
  if (!param || !callback || !call || !ts.isCallExpression(call)) return false;
  if (callback.parameters[0] !== param || call.arguments[0] !== callback) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "reduce" || callee.name.text === "reduceRight")
  );
}

function declarationSite(sf: ts.SourceFile): { pos: number; render: (text: string) => string } {
  let lastImport: ts.Statement | undefined;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) lastImport = stmt;
  }
  if (lastImport) return { pos: lastImport.end, render: (text) => `\n\n${text}` };
  const pos = sf.text.startsWith("#!") ? sf.text.indexOf("\n") + 1 : 0;
  return { pos, render: (text) => `${text}\n\n` };
}
