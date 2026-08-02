import ts from "typescript";

import type { ExtraOptions } from "./type-collector.js";

import {
  isLiteralUndefinedInitializer,
  isUnionProducingExpression,
} from "./expression-predicates.js";

// Position guards + the outer-annotation skip-set builder for the offset-based
// applier. All operate on a ts.SourceFile / raw source string — no ts.Program,
// no apply-types internals.

/**
 * Build a set of source positions where applying an outer type annotation
 * to a `const`/`let` declarator would conflict with the inner function
 * expression — either the inner already has annotations (regression), or
 * inner annotations will be filled in by separate per-position observations
 * (redundant + likely conflicting).
 *
 * For any `const f = (...) => ...` shape, ts-capture's runtime observes `f`
 * as a function VALUE and produces a `(arg: unknown) => unknown` outer
 * annotation; runtime separately observes the function's actual call
 * args/return and produces inner annotations. The two are contravariantly
 * incompatible (`unknown` outer vs. concrete inner) and TS rejects the
 * result (TS2322 / TS2365).
 *
 * Rule: never add an outer annotation on a var declarator whose RHS is
 * a function expression. Let the inner observations be the source of
 * truth — they always carry richer information than the function-value
 * fallback, regardless of whether the inner started typed or untyped.
 *
 * Edge case kept intentionally: this DOES NOT skip vars with non-function
 * RHS values (`const x = 42` still gets `: number`); the outer is the only
 * meaningful annotation site there.
 *
 * Cheap to compute: one ts.createSourceFile pass, no type checker.
 */
export interface ApplyContextSets {
  skip: Set<number>;
  // Positions where the varDecl initializer is a union-producing
  // expression (??, ||, ternary). When the SOLE observation is
  // `undefined`, computeAnnotationTypeString consults this set and
  // suppresses to avoid burning the wrong type onto a union site.
  unionProducingInitializer: Set<number>;
  // Arrow-param positions inside `Array.prototype.X(...)`
  // callbacks where X is one of the well-known contextually-typed methods
  // (filter, map, find, etc.). TS infers these param types from the array's
  // element type, so re-annotating with the observed structural shape adds
  // inline noise without value — multiplied across chained calls in real
  // codebases.
  arrayCallbackArrowParams: Set<number>;
  // (extension): VarDecl positions whose initializer is an
  // OPAQUE expression — anything other than a literal `undefined` /
  // `void X` / null / primitive constant. When sole observation is
  // `undefined`, the binding is almost certainly `T | undefined` (the
  // call's contract) and writing `: undefined` rejects all non-undefined
  // returns. Catches `await call()`, `service.fetch()`, `new Thing()`,
  // `getString(...)`, etc. The literal-initializer cases are NOT in the
  // set, so `let x = undefined` still gets `: undefined` annotated.
  opaqueInitializerVarDecls: Set<number>;
  // Source ranges that the user has explicitly marked as
  // off-limits for apply via a leading `// @ts-capture-ignore` (or
  // block-comment form) on the line preceding the declaration. Apply
  // checks each insertion position against these ranges and skips when
  // contained.
  ignoredRanges: Array<[number, number]>;
  // Source ranges of every ImportDeclaration in the file.
  // Apply must never insert a type annotation at any offset inside an
  // import statement — the resulting `import: T { ... }` is not valid
  // TypeScript. Defensive guard regardless of how a bad observation
  // entered the snapshot (instrumenter quirk, position shift, etc.).
  importRanges: Array<[number, number]>;
  // The set of legitimate insertion offsets for a `varDecl`
  // entry — every `name.end` of an Identifier-named Variable- or
  // PropertyDeclaration whose initializer is set. If apply sees a
  // `varDecl: true` entry whose offset isn't in this set, the offset
  // has drifted (e.g. landed between `const` and the identifier) and
  // emitting an annotation would wreck the source. Skip.
  validVarDeclEnds: Set<number>;
  // Follow-up: the set of legitimate insertion offsets
  // for `arrow: true` / param entries — every `name.end` of an
  // Identifier-named arrow/function param. Apply rejects entries
  // whose offset isn't in this set; symmetric guard to
  // `validVarDeclEnds`. The CST applier dispatches unrecognized
  // arrow positions to the offset-based path's passThrough, which
  // would otherwise insert in the middle of an unrelated identifier
  // (e.g. inside `companies.map` for an offset that doesn't match the
  // pre-JSX-transform position of the callback param).
  validArrowParamEnds: Set<number>;
}

/**
 * Returns the offset where a returnType annotation would
 * land for an arrow / function-expression. Mirrors transformer.ts's
 * `findCloseParenPos`: paren-less single-param arrows have no `)`, so
 * the insert lands at `parameters.end` (same as the lone param's
 * `name.end`); paren-wrapped arrows land at `closeParen + 1`. Used by
 * the returnType-skip index so apply can skip returnType-entries on the same
 * array-callback arrows it skips param-entries for.
 */
function arrowReturnTypePos(
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  source: string,
): number {
  const hasParens =
    arrow.parameters.length === 0 ||
    arrow.parameters.length > 1 ||
    source[arrow.parameters[0].pos - 1] === "(" ||
    source[arrow.parameters[0].getStart() - 1] === "(";
  if (!hasParens) return arrow.parameters.end;
  let pos = arrow.parameters.end;
  const limit = Math.min(source.length, arrow.end);
  while (pos < limit && source[pos] !== ")") pos++;
  if (pos >= limit) return arrow.parameters.end;
  return pos + 1;
}

/**
 * Built-in `Array.prototype` methods whose callback signature is fully
 * contextually typed from the array's element type. Re-annotating the
 * callback's params with observed structural shapes is pure noise: TS
 * has the type already.
 */
const ARRAY_CONTEXTUAL_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "filter",
  "map",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "forEach",
  "some",
  "every",
  "reduce",
  "reduceRight",
  "flatMap",
  "sort",
]);

/**
 * Marker recognized in leading comments. Conventional shape: same
 * vocabulary as `// @ts-ignore` / `// eslint-disable-next-line` so the
 * intent is immediately legible. Matches both line-comment and
 * block-comment forms; any whitespace around the token is fine.
 */
const TS_CAPTURE_IGNORE_RE = /@ts-capture-ignore\b/;

export function buildOuterAnnotationSkipSet(source: string): ApplyContextSets {
  const skip = new Set<number>();
  const unionProducingInitializer = new Set<number>();
  const arrayCallbackArrowParams = new Set<number>();
  const opaqueInitializerVarDecls = new Set<number>();
  const ignoredRanges: Array<[number, number]> = [];
  const importRanges: Array<[number, number]> = [];
  const validVarDeclEnds = new Set<number>();
  const validArrowParamEnds = new Set<number>();
  const sourceFile = ts.createSourceFile(
    "__ts-capture_apply.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  // Walk a stack of containing functions so we can detect generic-
  // function context for each visited varDecl. Push on enter, pop on
  // leave. Empty stack → top-level position (always safe to annotate).
  const fnStack: ts.SignatureDeclaration[] = [];

  function visit(node: ts.Node) {
    // Class-field PropertyDeclaration with an arrow / function-expression
    // initializer (e.g. `class Context { setLayout = (l: Layout) => {} }`)
    // needs the same skip. The CST applier handles both shapes; without
    // indexing PropertyDeclaration here, the offset-based path emits a
    // redundant `: (l: unknown) => unknown` outer annotation on the field.
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      skip.add(node.name.end);
    }

    // VarDecl whose initializer is a call with explicit type
    // arguments (`parseModelResponse<X>(json)`) — the position is
    // already typed via the generic argument. Inlining the structural
    // observation here duplicates the named type at best and replaces
    // it with a 1000-char inline shape at worst.
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.typeArguments &&
      node.initializer.typeArguments.length > 0
    ) {
      skip.add(node.name.end);
    }
    // VarDecl inside a generic-function body — the observation may
    // be a concrete materialization of one of the function's type
    // parameters; annotating with the concrete shape burns T to the
    // observed call's specifics and breaks the function for callers
    // using other Ts. Skip whenever any enclosing function carries
    // type parameters.
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      fnStack.some((f) => f.typeParameters && f.typeParameters.length > 0)
    ) {
      skip.add(node.name.end);
    }
    // Index varDecl positions whose initializer is a union-producing
    // expression. computeAnnotationTypeString consults this to decide
    // whether a sole `undefined` observation is a narrowing risk.
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isUnionProducingExpression(node.initializer)
    ) {
      unionProducingInitializer.add(node.name.end);
    }
    // Index varDecl positions whose initializer is an OPAQUE
    // expression (anything not a literal undefined / void X). When the
    // sole observation is `undefined`, the apply loop skips — the
    // binding is almost certainly `T | undefined` from the call's
    // contract, not literal `undefined`.
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      !isLiteralUndefinedInitializer(node.initializer)
    ) {
      opaqueInitializerVarDecls.add(node.name.end);
    }

    // If this node is a CallExpression on a member
    // access where the property name is a known contextually-typing
    // Array.prototype method, index every arrow-callback param's end
    // position AND the arrow's returnType insertion position. The main
    // apply loop skips arrow- and returnType-typed observations at
    // these positions when emitted is a structural shape — TS infers
    // the callback contract from the array's element type.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      ARRAY_CONTEXTUAL_CALLBACK_METHODS.has(node.expression.name.text)
    ) {
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          for (const param of arg.parameters) {
            if (ts.isIdentifier(param.name)) {
              arrayCallbackArrowParams.add(param.name.end);
            }
          }
          // Arrow returnType position: paren-wrapped arrows place it
          // after the close-paren; paren-less arrows place it at
          // parameters.end (same as the param's name.end).
          arrayCallbackArrowParams.add(arrowReturnTypePos(arg, source));
        }
      }
    }

    // Declarations that opt out via a leading @ts-capture-ignore
    // comment contribute their full source range to the ignored-ranges
    // list. Apply later checks each insertion position against these
    // ranges and skips when contained.
    if (isIgnorableForCaptureIgnore(node) && hasCaptureIgnoreLeadingComment(node, source)) {
      ignoredRanges.push([node.pos, node.end]);
    }

    // Record every ImportDeclaration's source range. Apply's
    // per-entry loop hard-skips any offset that falls inside one of
    // these ranges — there is no legitimate insertion point inside an
    // import statement, and producing `import: T { ... }` wrecks the
    // file unrecoverably.
    if (ts.isImportDeclaration(node)) {
      importRanges.push([node.getStart(sourceFile), node.end]);
    }

    // Record every legitimate `varDecl` insertion point —
    // the `name.end` of an Identifier-named Variable/PropertyDeclaration
    // whose initializer is set. Apply hard-skips any `varDecl` entry
    // whose offset isn't in this set (covers position drift between
    // instrumenter-view source and apply-view source).
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      validVarDeclEnds.add(node.name.end);
    }

    // Same idea for arrow / function param sites — record every
    // param's `name.end` so apply can reject `arrow: true` / param
    // entries whose offset has drifted. Both identifier-named params
    // (`(x) =>`) and destructured patterns (`({ a, b }) =>`,
    // `([a, b]) =>`) qualify; for the latter the instrumenter uses
    // `param.name.end` which is the closing `}` / `]` of the
    // pattern.
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      for (const param of node.parameters) {
        validArrowParamEnds.add(param.name.end);
      }
    }

    const pushedFn = isFunctionLikeForGenericContext(node);
    if (pushedFn) fnStack.push(node as ts.SignatureDeclaration);
    ts.forEachChild(node, visit);
    if (pushedFn) fnStack.pop();
  }

  visit(sourceFile);
  return {
    skip,
    unionProducingInitializer,
    arrayCallbackArrowParams,
    opaqueInitializerVarDecls,
    ignoredRanges,
    importRanges,
    validVarDeclEnds,
    validArrowParamEnds,
  };
}

/**
 * Statement-level / declaration nodes where a leading
 * `// @ts-capture-ignore` makes sense. Restricting to these keeps the
 * ignored-range list small and avoids attaching false leading comments
 * to deeply-nested expressions.
 */
function isIgnorableForCaptureIgnore(node: ts.Node): boolean {
  return (
    ts.isVariableStatement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isExpressionStatement(node)
  );
}

function hasCaptureIgnoreLeadingComment(node: ts.Node, source: string): boolean {
  const ranges = ts.getLeadingCommentRanges(source, node.pos);
  if (!ranges) return false;
  return ranges.some((r) => TS_CAPTURE_IGNORE_RE.test(source.slice(r.pos, r.end)));
}

/**
 * Built-in `Array.prototype` methods whose return type is `T | undefined`
 * regardless of the array's static type — observing either branch alone
 * loses the other half of the union.
 */

/**
 * True for AST node kinds whose `typeParameters` field carries the
 * generic-context signal needed. Excludes ConstructorDeclaration —
 * generics on classes are declared at the class level, and constructor-
 * scoped varDecls don't directly substitute T.
 */
function isFunctionLikeForGenericContext(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * When an arrow-param observation arrives without `opts.parens` (stale
 * types.json, hand-synthesized entry, etc.), the offset applier needs to
 * detect paren-less context from source to avoid emitting
 * `param: T => body` (TS1005).
 *
 * The detection looks BACKWARD from `pos` (the name.end position)
 * to find the start of the identifier, and FORWARD to find `=>`
 * with only whitespace/comments in between. If both hold AND the
 * character before the identifier is NOT `(` (or a different
 * token), this is a paren-less single-param arrow that needs
 * wrapping. Returns `[paramStart, paramEnd]` or undefined.
 */
export function detectParenLessArrowParam(
  source: string,
  pos: number,
): [number, number] | undefined {
  if (pos <= 0 || pos > source.length) return undefined;
  // Walk back to the start of the identifier.
  let identStart = pos;
  while (identStart > 0 && /[\w$]/.test(source[identStart - 1])) identStart--;
  if (identStart === pos) return undefined; // not an identifier
  // Walk forward past whitespace to look for `=>`. If we encounter a
  // closing `)` before `=>`, the param IS wrapped — distinguishes
  // `(x) => body` (wrapped) from `x => body` (paren-less) and from
  // `f(x => body)` (paren-less; the outer `(` belongs to the call).
  let p = pos;
  while (p < source.length && /\s/.test(source[p])) p++;
  if (source[p] === ")") return undefined; // wrapped
  if (source[p] !== "=" || source[p + 1] !== ">") return undefined;
  return [identStart, pos];
}

/**
 * Detect that the annotation a typeInfo entry would insert is already
 * present in the source — i.e. apply has already run on this file with
 * (a superset of) this typeInfo. Skipping prevents double-annotation
 * when users iterate (`ts-capture apply types.json` twice) without
 * checking the file state.
 *
 * The insertion patterns we cover (in order of how the existing apply
 * code shapes the inserted text):
 *  - varDecl / param / return: insert ": TYPE" at pos. Post-apply,
 *    source[pos] === ":". For optional params (`a?`), source[pos-1]
 *    === "?" and source[pos] === ":" (the "?:" is contiguous).
 *  - thisType: insert "this: TYPE" at pos. Post-apply, source from
 *    pos starts with "this:" (or "this:" preceded by a comma if
 *    thisNeedsComma was set).
 *  - parens-wrap (arrow that needs parens): insert "(" before and
 *    ":" inside. Idempotency for this case is detectable by the
 *    parens already being there. Conservative: only handle the common
 *    cases here; the parens path is rare in practice and re-applying
 *    is no worse than the existing dedup-by-key behavior would allow.
 *
 * **Known limitation: multi-entry shift.** This check looks at the
 * source's CURRENT char at `pos`. If `pos` came from a typeInfo dump
 * keyed to the ORIGINAL (pre-shift) source, but the source has been
 * shifted by an earlier apply for a LOWER position, then `pos` no
 * longer refers to the original site — it refers to whatever
 * character ended up at that offset post-shift. So multi-entry
 * idempotency works ONLY for entries whose position is unaffected
 * by other-entry shifts (which in practice means single-entry, or
 * the lowest-pos entry across multiple). For full-file idempotency,
 * the canonical fix is a sidecar manifest keyed on source-file hash +
 * typeInfo hash, written after a successful apply, consulted before
 * the next. That belongs at the CLI level (\`cmdApply\`), not here.
 *
 * False-positive risk on the case we DO handle: a user happens to
 * have written ":" at the exact insertion position of an unrelated,
 * never-applied annotation. Implausible — the position is computed
 * from instrumentation, which only fires on *untyped* declarations
 * (no ":" there pre-instrument). Worst case: we miss a real
 * annotation. A \`--force\` CLI flag is the easy bypass.
 */
export function isAlreadyApplied(
  source: string,
  pos: number,
  opts: ExtraOptions | undefined,
): boolean {
  if (opts?.thisType) {
    // "this:" or "this :" (with whitespace tolerance) starting at pos.
    return /^this\s*:/.test(source.slice(pos, pos + 8));
  }
  // Default case: ":" at pos. The optional-param "?" is at pos-1, so
  // the colon is still at pos.
  return source[pos] === ":";
}

/**
 * Defense against stale offsets when collect and apply are separated
 * by a source edit. The collector captures positions valid for the
 * source as observed; if the user edits the source before apply, those
 * positions may point at unrelated tokens. Without this guard, apply
 * silently inserts annotations at the wrong byte (e.g.
 * `export const : numberquux = 1;` when pos was supposed to be the
 * parameter `a` of `function foo(a)` but now points mid-identifier).
 *
 * Heuristic: each opts kind has a known character-class signature at
 * the insertion site. If the current source doesn't match, the
 * position is stale; skip the entry.
 *
 *  - `opts.thisType`: pos is just after the `(` of a params list →
 *    source[pos-1] must be `(`.
 *  - `opts.returnType`: pos is just after the `)` of a params list →
 *    source[pos-1] must be `)`.
 *  - everything else (param / varDecl / parens-arrow): pos is at the
 *    END of an identifier → source[pos-1] is an identifier character
 *    AND source[pos] is NOT an identifier character. A "?" before pos
 *    (optional param) is also accepted.
 *
 * False-negative risk: a legitimate position that doesn't match the
 * heuristic gets skipped. Worst case: ts-capture leaves an implicit-any
 * the user has to type by hand. False-positive risk: a stale position
 * happens to land at a token boundary of the right shape — silent
 * mis-annotation can still slip through. The hash-of-source guard
 * (separate item) is the next layer of defense.
 */
export function positionLooksLikeInsertionSite(
  source: string,
  pos: number,
  opts: ExtraOptions | undefined,
): boolean {
  if (pos <= 0 || pos > source.length) return false;
  const before = source[pos - 1];
  const after = pos < source.length ? source[pos] : "";
  const isIdent = (c: string): boolean => /[\w$]/.test(c);

  if (opts?.thisType) return before === "(";
  if (opts?.returnType) {
    // Standard case: pos is right after the function's `)`.
    if (before === ")") return true;
    // Paren-less arrow: pos == param.name.end. No `)` to anchor on
    // since the arrow has no params-parens — but the position IS a
    // valid return-type insertion site. Sibling returnType-entries on
    // paren-less arrows have to land for the wrap-injection to do its
    // job; without this branch they're pre-rejected here and the
    // `state: T => body` syntax error surfaces instead.
    return detectParenLessArrowParam(source, pos) !== undefined;
  }
  // Param / varDecl / parens-arrow: pos is at end of a binding —
  // either an identifier OR a destructure pattern (`}` for object,
  // `]` for array). Optional-param case: source[pos-1] is "?".
  const effectiveBefore = before === "?" && pos >= 2 ? source[pos - 2] : before;
  const isBindingEnd =
    isIdent(effectiveBefore) || effectiveBefore === "}" || effectiveBefore === "]";
  return isBindingEnd && !isIdent(after);
}
