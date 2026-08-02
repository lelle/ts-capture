import ts from "typescript";

import type { ApplyTypesOptions } from "./contract.js";
import type { CollectedTypeInfo } from "./type-collector.js";

import { decideVarDeclSite, suppressArrayCallbackStructural } from "./annotation-eligibility.js";
import { buildDiagnosticMarkerSuffix } from "./apply-diagnostics.js";
import { filterAcceptedReplacements } from "./apply-types-verify.js";
import { inferClassFieldTypes } from "./class-field-inference.js";
import { computeAnnotationTypeString } from "./compute-annotation.js";
import { INFER_DEFAULTS } from "./configuration.js";
import {
  buildInferableInfoMap,
  type InferableInfo,
  inferTypeFromInitializer,
} from "./initializer-inference.js";
import {
  buildNamedTypeIndex,
  type NamedTypeIndex,
  rewriteToNamedInScope,
} from "./named-type-rewrite.js";
import { isParseableTypeString } from "./parseable.js";
import { type AnnotationCandidate, applyReplacements, Replacement } from "./replacement.js";
import {
  allTypeRefsInScope,
  buildCtorArityMap,
  buildScopedTypeNames,
  buildScopedTypeNamesViaTypeChecker,
  expandCtorArity,
} from "./scope-reachability.js";
import {
  buildOuterAnnotationSkipSet,
  detectParenLessArrowParam,
  isAlreadyApplied,
  positionLooksLikeInsertionSite,
} from "./skip-sets.js";

export function applyTypesToFile(
  source: string,
  typeInfo: CollectedTypeInfo,
  options: ApplyTypesOptions,
  program?: ts.Program,
): string {
  // Per-file ignore. Highest-priority short-circuit — when the
  // file matches any user-supplied pattern, we never touch its source.
  if (
    options.filename &&
    options.ignoreFiles &&
    options.ignoreFiles.some((p) => p.test(options.filename!))
  ) {
    return source;
  }

  const replacements: Replacement[] = [];
  const prefix = options.prefix ?? "";
  const infer = options.infer ?? INFER_DEFAULTS;
  const {
    skip: outerAnnotationSkipSet,
    unionProducingInitializer,
    arrayCallbackArrowParams,
    opaqueInitializerVarDecls,
    ignoredRanges,
    importRanges,
    validVarDeclEnds,
    validArrowParamEnds,
  } = buildOuterAnnotationSkipSet(source);
  // Lazy: only parse the source for inferable-info when the flag is on;
  // an empty Map for the off-path means the lookup loop below is a
  // single Map.has() per entry, which is constant-time.
  const inferableInfoMap: Map<number, InferableInfo> = infer.skipInferableVarDecls
    ? buildInferableInfoMap(source)
    : new Map();
  // When Program + filename available, use the cross-file index (seeded
  // with same-file via getSymbolsInScope). Falls back to same-file-only
  // when no Program is provided.
  const namedTypeIndex: NamedTypeIndex | undefined = infer.preferNamedInScope
    ? buildNamedTypeIndex(source, program, options.filename)
    : undefined;
  // Scope discovery for emitted-name reachability. TypeChecker-based
  // when Program + filename are available — includes DOM types,
  // namespace roots, re-exports. Falls back to text-level (imports +
  // same-file decls + ECMA core).
  const scopedTypeNames: Set<string> | undefined = (() => {
    if (!infer.requireTypeRefInScope) return undefined;
    if (program && options.filename) {
      const fromTC = buildScopedTypeNamesViaTypeChecker(program, options.filename);
      if (fromTC) return fromTC;
    }
    return buildScopedTypeNames(source, options.filename);
  })();

  // Arity map for expanding bare generic class/interface names with
  // `<unknown, ...>` so TS2314 doesn't fire on user-defined generic ctors.
  // Only built when Program + filename are present (falls back to no-op).
  const ctorArityMap: Map<string, number> | undefined =
    program && options.filename ? buildCtorArityMap(program, options.filename) : undefined;

  // Synthesize class-field type-info entries from constructor-param
  // assignments before the main pipeline. These flow through dedup, merge,
  // and replacement just like real observations.
  const fieldEntries = inferClassFieldTypes(source, typeInfo);
  if (fieldEntries.length > 0) {
    typeInfo = [...typeInfo, ...fieldEntries];
  }

  // Deduplicate entries at the same insertion site. Parallel test runners
  // (vitest workers, jest forks) observe the same code path many times;
  // without this, two observations of `const x = true` would produce
  // `const x: boolean: boolean = true` (one Replacement.insert per entry).
  // Same pos + same opts = same site; merge their type observations.
  const dedupedTypeInfo = new Map<string, CollectedTypeInfo[number]>();
  for (const entry of typeInfo) {
    const [file, pos, types, opts] = entry;
    const key = `${file}\x00${pos}\x00${JSON.stringify(opts ?? null)}`;
    const existing = dedupedTypeInfo.get(key);
    if (existing) {
      existing[2].push(...types);
    } else {
      // Clone the types array so later merges don't mutate the caller's input.
      dedupedTypeInfo.set(key, [file, pos, [...types], opts]);
    }
  }

  // Track paramStart positions where a paren-less-arrow wrap has been
  // emitted, so multiple landing entries at the same pos don't push
  // double `(` / `)`.
  const wrappedParamStarts = new Set<number>();

  // When verify is enabled, buffer annotation
  // insertions here and decide acceptance in a single batch pass at
  // the end of the entry loop. Without verify, this stays empty.
  const annotationCandidates: AnnotationCandidate[] = [];

  const telemetry = options.telemetry;
  for (const [, pos, types, opts] of dedupedTypeInfo.values()) {
    if (telemetry) telemetry.totalEntries++;
    // User opt-out via @ts-capture-ignore comment — applies to
    // any insertion position (varDecl, param, return type, class
    // field) within the marked declaration's source range. Highest-
    // priority skip; runs before every other check so users can
    // confidently silence an apply they know is wrong without
    // worrying about which downstream filter would have caught it.
    if (ignoredRanges.some(([s, e]) => pos >= s && pos < e)) {
      continue;
    }

    // Defensive hard-skip — any offset inside an import
    // statement is unreachable for a legitimate annotation. A bad
    // observation that survives the instrumenter and lands here would
    // emit `import: T { ... }` and wreck the file. Cheaper to filter
    // here than to debug every code path that might produce one.
    if (importRanges.some(([s, e]) => pos >= s && pos < e)) {
      continue;
    }

    // A `varDecl` entry's offset must be the exact `name.end`
    // of a Variable/PropertyDeclaration recognized in the current source
    // AST. When the offset has drifted — e.g. between the `const`
    // keyword and the identifier in `export const X = …`, or between
    // `export` and `const` — emitting `: T` would produce
    // `export const: T X = …` which is not parseable TypeScript. The
    // drift typically comes from instrumenter-view source (post-JSX
    // transform) not matching apply-view source (original TSX); see
    // REPORT.md §Bug 2. Drop the entry rather than guess.
    if (opts?.varDecl && !validVarDeclEnds.has(pos)) {
      continue;
    }

    // Same idea for `arrow: true` / param entries: an arrow-param
    // annotation must land at the
    // exact `name.end` of an Identifier-named function param in the
    // current AST. If the snapshot's offset doesn't match — because
    // the instrumenter saw post-JSX-transform source — emitting the
    // annotation lands in the middle of unrelated code (e.g. inside
    // `companies.map` for a captured callback param). Drop instead.
    if (opts?.arrow && !validArrowParamEnds.has(pos)) {
      continue;
    }

    // Function-expression guard: if this insertion targets a variable
    // name whose RHS is a function expression with its own annotations,
    // dropping in a `(arg: unknown) => unknown` outer annotation would
    // regress / break type-checking. Skip the outer insertion; inner
    // observations target different positions and are unaffected.
    // Shared var-decl eligibility (annotation-eligibility.ts), the same
    // decision the CST applier uses: outer-annotation-conflict skips (function
    // RHS / type-args / generic context, collapsed into `outerAnnotationSkipSet`),
    // union-producing + single observation, and opaque + sole-`undefined`.
    // Idempotency stays with this path's own `isAlreadyApplied` below, so
    // `hasType` is left false here.
    if (opts?.varDecl) {
      const verdict = decideVarDeclSite(
        {
          outerAnnotationSkip: outerAnnotationSkipSet.has(pos),
          isUnionProducingInitializer: unionProducingInitializer.has(pos),
          hasOpaqueInitializer: opaqueInitializerVarDecls.has(pos),
          hasType: false,
        },
        types.length,
        types[0]?.[0] === "undefined",
        infer.ignoreExistingTypes,
      );
      if (verdict === "drop") continue;
    }

    // When the user wrote `const w = window as MyWindow` they explicitly
    // told TypeScript what type to use; ts-capture observing the runtime
    // value (jsdom-window with 6KB of synthetics) and emitting a
    // structural type fights the user's intent. Skip varDecl entries
    // marked hasAsCast so the cast stands.
    if (opts?.hasAsCast && infer.honorAsCasts) continue;

    // Stale-offset guard: if the source has been edited between collect
    // and apply, the captured pos may point mid-token in the current
    // source. Inserting there silently corrupts the file (e.g.
    // `const : Tname = 1;`). Skip if pos doesn't match the expected
    // character-class signature for this opts kind.
    if (!positionLooksLikeInsertionSite(source, pos, opts)) {
      if (telemetry) telemetry.positionMismatch++;
      continue;
    }

    // Idempotency: detect that this insertion site has already been
    // applied in a previous run on this source file. Without this,
    // running `ts-capture apply types.json` twice would write the
    // annotation twice (e.g. `function foo(a: string: string)`).
    // Pattern matches what each opts-shape inserts:
    //  - param/return/varDecl: ":" at pos (post-insert), or "?:" if optional
    //  - thisType: "this:" starting at pos
    // Bypassed when `infer.ignoreExistingTypes` is on — the
    // measurement workflow needs to capture what we WOULD emit at
    // already-typed positions even though the output is broken TS.
    if (!infer.ignoreExistingTypes && isAlreadyApplied(source, pos, opts)) {
      if (telemetry) telemetry.idempotent++;
      continue;
    }

    const isOptional = source[pos - 1] === "?";

    const computed = computeAnnotationTypeString(types, opts, infer, isOptional, program);
    if (computed === null) continue;
    const named = rewriteToNamedInScope(computed, namedTypeIndex);
    // Fill `<unknown, ...>` for bare generic class/interface names so
    // TS2314 doesn't fire. No-op when no Program is available.
    const emitted = ctorArityMap ? expandCtorArity(named, ctorArityMap) : named;
    // Skip when the annotation references a name that isn't reachable
    // as a type at this file (would emit TS2304). Always-on by default;
    // off via `infer.requireTypeRefInScope: false`.
    if (!allTypeRefsInScope(emitted, scopedTypeNames)) continue;

    // Suppress arrow-param AND arrow-returnType
    // annotation when the arrow is a callback to a well-known
    // Array.prototype method AND the would-be annotation is a
    // structural object type. TS contextually types the callback
    // contract from the array's element type, so inlining a
    // multi-hundred-character structural shape at every callsite (and
    // multiplying it across chained `.filter().map().some()`) adds
    // pure noise. Primitive annotations (`number`, `string`, `boolean`)
    // are still allowed — they're cheap and may confirm the contextual
    // type at a glance. After `rewriteToNamedInScope`, if the emitted
    // string is a named type (no `{`), pass it through; the named-type
    // rewrite is itself the desired outcome.
    if (
      (opts?.arrow || opts?.returnType) &&
      suppressArrayCallbackStructural(arrayCallbackArrowParams.has(pos), emitted)
    ) {
      continue;
    }

    // Defense-in-depth — refuse to emit a type string that
    // doesn't parse as TypeScript. The runtime stringifier was
    // hardened in value-walker.ts for destructured / renamed params,
    // but a future bug in any code path that constructs a type string
    // could still produce something ungrammatical. Catch it here
    // rather than write an unrecoverable diff to disk.
    if (!isParseableTypeString(emitted)) {
      if (telemetry) telemetry.unparseable++;
      continue;
    }

    let thisPrefix = "";
    let suffix = "";

    // Paren-less arrow wrap is a property of the source POSITION, not
    // the entry. Compute the wrap range here for any entry that lands
    // at a paren-less single-param arrow pos — arrow-entries,
    // returnType-entries, anything else. Dedup so only the first
    // landing entry pushes the `(` + synthetic `)`.
    //
    // Why not gate on opts.arrow: when preferNamedInScope or
    // requireTypeRefInScope rejects the arrow-entry, the returnType
    // entry still lands at the same pos. Without position-level
    // detection, `state: T_ret => body` slips through (TS1005).
    let positionParens: [number, number] | undefined;
    if (!opts?.thisType && !opts?.varDecl) {
      positionParens = detectParenLessArrowParam(source, pos);
    }
    const parensRange = opts?.parens ?? positionParens;

    if (parensRange && !wrappedParamStarts.has(parensRange[0])) {
      wrappedParamStarts.add(parensRange[0]);
      // Two-replacement wrap: `(` at paramStart, `)` at pos. Priority
      // 0 for `)` lands it BETWEEN returnType annotations (priority
      // -1, processed first → end up AFTER `)` in output) and param
      // annotations (priority 1, processed last → end up BEFORE `)`
      // in output). Decoupling `)` from the entry's suffix lets the
      // wrap survive any single entry being skipped.
      replacements.push(Replacement.insert(parensRange[0], "("));
      replacements.push(Replacement.insert(pos, ")", 0));
    }
    if (opts?.thisNeedsComma) {
      suffix = ", ";
    }
    if (opts?.thisType) {
      thisPrefix = "this";
    }

    // Priority scheme for inserts at the same pos (applyReplacements
    // sorts ASC; higher priority lands CLOSER to pos in the output):
    //   - returnType annotation: -1 (lowest; ends up FURTHEST right,
    //     after the `)`)
    //   - synthetic `)` from wrap:  0 (pushed above, between param
    //     annotation and returnType)
    //   - param / varDecl / thisType annotation: 1 (highest; ends up
    //     CLOSEST to pos, before the `)`)
    //
    // Net at a paren-less arrow with arrow + returnType:
    //   "(x: T_arrow): T_ret => body"
    //         ^pos with `: T_arrow` (pri 1), `)` (pri 0), `: T_ret` (pri -1)
    const insertPriority = opts?.returnType ? -1 : 1;

    // Skip annotations TS would already infer from the initializer.
    // Only fires when both `infer.skipInferableVarDecls` is on AND the
    // entry is a varDecl/class-field — function params, return types,
    // and `this` annotations stay (TS doesn't infer those from the
    // surrounding code). Detection is purely syntactic; we bail out for
    // anything we can't model exactly to avoid suppressing a useful
    // annotation.
    if (infer.skipInferableVarDecls && opts?.varDecl) {
      const info = inferableInfoMap.get(pos);
      if (info) {
        const inferredFromSource = inferTypeFromInitializer(info.initializer, info.narrowsLiterals);
        if (inferredFromSource !== null && inferredFromSource === emitted) continue;
      }
    }

    // Append a `/* @ts-capture:<reason> *​/` marker when the entry's
    // observation(s) include an approximation reason and the user has
    // opted in via `infer.emitDiagnosticComments`. Reviewers use the
    // markers to distinguish confident emits from fallbacks.
    const markerSuffix = buildDiagnosticMarkerSuffix(types, infer);

    const annotationText = thisPrefix + ": " + prefix + emitted + suffix + markerSuffix;

    // Defer verify to a batch pass at the end of
    // the entry loop. Per-candidate probing was 30× slower than
    // necessary on the happy path. Here we just record the
    // annotation insertion as a candidate; the batch pass below
    // decides which actually get pushed to `replacements`.
    if (options.verify) {
      annotationCandidates.push({
        pos,
        text: annotationText,
        priority: insertPriority,
      });
      continue;
    }

    replacements.push(Replacement.insert(pos, annotationText, insertPriority));
    if (telemetry) telemetry.emitted++;
  }

  // Batch verify pass. Buffered candidates are
  // probed in one shot (fast path: all-or-nothing). If the batch
  // introduces new diagnostics, fall back to greedy per-candidate
  // acceptance. Either way, only accepted candidates push their
  // insertion into `replacements`.
  if (options.verify && annotationCandidates.length > 0) {
    const probes = annotationCandidates.map((c) => ({
      start: c.pos,
      end: c.pos,
      text: c.text,
    }));
    const acceptedIdx = filterAcceptedReplacements(options.verify, probes);
    const acceptedSet = new Set(acceptedIdx);
    for (const i of acceptedIdx) {
      const c = annotationCandidates[i];
      replacements.push(Replacement.insert(c.pos, c.text, c.priority));
      if (telemetry) telemetry.emitted++;
    }
    if (telemetry) {
      // Candidates not in the accepted set were rejected by the oracle.
      telemetry.verifyReject += annotationCandidates.length - acceptedSet.size;
    }
  }

  return applyReplacements(source, replacements);
}

export function applyTypesToFiles(
  typeInfo: CollectedTypeInfo,
  _options: ApplyTypesOptions = {},
): Map<string, { source: string; typeInfo: CollectedTypeInfo }> {
  const grouped = new Map<string, CollectedTypeInfo>();
  for (const entry of typeInfo) {
    const file = entry[0];
    const existing = grouped.get(file);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(file, [entry]);
    }
  }

  const result = new Map<string, { source: string; typeInfo: CollectedTypeInfo }>();
  for (const [file, entries] of grouped) {
    result.set(file, { source: file, typeInfo: entries });
  }
  return result;
}
