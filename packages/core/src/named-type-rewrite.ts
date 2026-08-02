import ts from "typescript";

import { parseObjectType, splitTopLevelUnion } from "./type-merge.js";

type PartitionedMembers = { required: Map<string, string>; optional: Map<string, string> };
type MemberPair = { key: string; type: string };

/**
 * Build a map from canonical structural-shape string to interface /
 * type-alias name found in the SAME source file. Apply consults this map
 * (when `infer.preferNamedInScope` is on) to substitute named types for
 * structural ones that exactly match.
 *
 * Limitations — interfaces with extends-clauses, type parameters, or
 * non-property-signature members are skipped (no resolver to model
 * those safely without import-following). Imports are also skipped — the
 * cross-file index covers those via TypeChecker.
 */
/**
 * Build a structured index of same-file named types (interface +
 * type alias declarations whose body is a type literal). For each type,
 * partition fields into required vs optional so the subset matcher can
 * decide whether an observation is structurally a subset.
 *
 * Mirrors buildSameFileNamedTypeIndex's filters (skip generics, skip
 * heritage clauses, skip non-property-signature members) — same set of
 * named types appear in both indexes.
 */
function buildSameFileSubsetIndex(source: string): SubsetNamedTypeIndex {
  const index: SubsetNamedTypeIndex = [];
  const sourceFile = ts.createSourceFile(
    "__ts-capture_subset_index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function partitionMembers(members: readonly ts.TypeElement[]): PartitionedMembers | null {
    const required = new Map<string, string>();
    const optional = new Map<string, string>();
    for (const m of members) {
      if (!ts.isPropertySignature(m)) return null;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
      if (name === null || !m.type) return null;
      const typeText = m.type.getText(sourceFile).trim();
      if (m.questionToken) optional.set(name, typeText);
      else required.set(name, typeText);
    }
    return { required, optional };
  }
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      if (stmt.heritageClauses?.length) continue;
      if (stmt.typeParameters?.length) continue;
      const parts = partitionMembers(stmt.members);
      if (parts) {
        index.push({
          name: stmt.name.text,
          requiredFields: parts.required,
          optionalFields: parts.optional,
        });
      }
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      if (stmt.typeParameters?.length) continue;
      if (!ts.isTypeLiteralNode(stmt.type)) continue;
      const parts = partitionMembers(stmt.type.members);
      if (parts) {
        index.push({
          name: stmt.name.text,
          requiredFields: parts.required,
          optionalFields: parts.optional,
        });
      }
    }
  }
  return index;
}

function buildSameFileNamedTypeIndex(source: string): Map<string, string> {
  const index = new Map<string, string>();
  const sourceFile = ts.createSourceFile(
    "__ts-capture_named_index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function canonicalizeMembers(members: readonly ts.TypeElement[]): string | null {
    const pairs: MemberPair[] = [];
    for (const m of members) {
      if (!ts.isPropertySignature(m)) return null;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
      if (name === null || !m.type) return null;
      const typeText = m.type.getText(sourceFile).trim();
      pairs.push({ key: name, type: typeText });
    }
    pairs.sort((a, b) => a.key.localeCompare(b.key));
    return "{ " + pairs.map((p) => p.key + ": " + p.type).join(", ") + " }";
  }
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      if (stmt.heritageClauses?.length) continue;
      if (stmt.typeParameters?.length) continue;
      const canonical = canonicalizeMembers(stmt.members);
      if (canonical && !index.has(canonical)) index.set(canonical, stmt.name.text);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      if (stmt.typeParameters?.length) continue;
      if (!ts.isTypeLiteralNode(stmt.type)) continue;
      const canonical = canonicalizeMembers(stmt.type.members);
      if (canonical && !index.has(canonical)) index.set(canonical, stmt.name.text);
    }
  }
  return index;
}

/**
 * Cross-file named-type index for the `preferNamedInScope` substitution.
 * Uses `getSymbolsInScope` to discover named types reachable through
 * imports, not just same-file decls. Example:
 * `import { BookingState } from './state/types'` makes BookingState a
 * substitution candidate from any file in the project.
 *
 * Precedence: same-file declarations win on shape-collision with
 * cross-file imports. Implemented by seeding the index with the
 * same-file build first, then merging cross-file with skip-if-exists.
 * `getSymbolsInScope` enumeration order is not guaranteed innermost-
 * out in all TS versions, so explicit precedence beats relying on it.
 *
 * Generic interfaces / type aliases, interfaces with extends-clauses,
 * and non-property-signature members are skipped.
 *
 * Returns undefined when the file isn't in the Program (out-of-project,
 * dynamic) — caller falls back to same-file-only build via source.
 */
function buildCrossFileNamedTypeIndex(
  program: ts.Program,
  filename: string,
  source: string,
): Map<string, string> | undefined {
  const sf = program.getSourceFile(filename);
  if (!sf) return undefined;
  // Seed with same-file first to guarantee precedence on collision.
  const index = buildSameFileNamedTypeIndex(source);
  const checker = program.getTypeChecker();

  function canonicalizeMembers(
    members: readonly ts.TypeElement[],
    declSourceFile: ts.SourceFile,
  ): string | null {
    const pairs: MemberPair[] = [];
    for (const m of members) {
      if (!ts.isPropertySignature(m)) return null;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
      if (name === null || !m.type) return null;
      const typeText = m.type.getText(declSourceFile).trim();
      pairs.push({ key: name, type: typeText });
    }
    pairs.sort((a, b) => a.key.localeCompare(b.key));
    return "{ " + pairs.map((p) => p.key + ": " + p.type).join(", ") + " }";
  }

  const flags = ts.SymbolFlags.Type | ts.SymbolFlags.Alias;
  const symbols = checker.getSymbolsInScope(sf, flags);
  for (const sym of symbols) {
    // Resolve alias (import) to the underlying declaration symbol.
    let resolved = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        resolved = checker.getAliasedSymbol(sym);
      } catch {
        continue; // unresolved alias — skip
      }
    }
    const decls = resolved.getDeclarations();
    if (!decls) continue;
    for (const decl of decls) {
      // Skip declarations from the target file itself — already in
      // the seed via the same-file scan. Avoids double-counting and
      // preserves the same-file canonical shape (which may differ in
      // whitespace from the TC's getText).
      if (decl.getSourceFile() === sf) continue;
      const declSf = decl.getSourceFile();
      // Skip declaration files (lib.*.d.ts, @types/*, third-party
      // declarations). Without this filter, a structural type like
      // `{ value: number }` matches lib.dom.d.ts's SVGNumber
      // (single-field interface with `value: number`) — an
      // unintended substitution. Only user-authored interfaces and
      // type aliases should compete for shape matches.
      if (declSf.isDeclarationFile) continue;
      let canonical: string | null = null;
      if (ts.isInterfaceDeclaration(decl)) {
        if (decl.typeParameters?.length) continue;
        if (decl.heritageClauses?.length) continue;
        canonical = canonicalizeMembers(decl.members, declSf);
      } else if (ts.isTypeAliasDeclaration(decl)) {
        if (decl.typeParameters?.length) continue;
        if (!ts.isTypeLiteralNode(decl.type)) continue;
        canonical = canonicalizeMembers(decl.type.members, declSf);
      }
      if (canonical && !index.has(canonical)) {
        index.set(canonical, sym.getName());
      }
    }
  }
  return index;
}

/**
 * Cross-file variant: structured subset-match index assembled from
 * scope-visible named types (imports + same-file). Mirrors
 * buildCrossFileNamedTypeIndex's traversal but partitions members into
 * required vs optional so the subset matcher can decide compatibility.
 */
function buildCrossFileSubsetIndex(
  program: ts.Program,
  filename: string,
  source: string,
): SubsetNamedTypeIndex | undefined {
  const sf = program.getSourceFile(filename);
  if (!sf) return undefined;
  const index: SubsetNamedTypeIndex = buildSameFileSubsetIndex(source);
  const seenNames = new Set(index.map((e) => e.name));

  function partition(
    members: readonly ts.TypeElement[],
    declSf: ts.SourceFile,
  ): PartitionedMembers | null {
    const required = new Map<string, string>();
    const optional = new Map<string, string>();
    for (const m of members) {
      if (!ts.isPropertySignature(m)) return null;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
      if (name === null || !m.type) return null;
      const typeText = m.type.getText(declSf).trim();
      if (m.questionToken) optional.set(name, typeText);
      else required.set(name, typeText);
    }
    return { required, optional };
  }

  // Walk every user-authored source file in the Program — not just
  // symbols `getSymbolsInScope` returns, because subset matching is
  // useful for types reachable only transitively (e.g. via index types
  // like `BookingState['availableProducts']`). The scope check at
  // emission time (`allTypeRefsInScope`) filters out matches whose
  // name isn't reachable as a type at the apply site, so widening
  // the search here is safe — false matches end up skipped entirely
  // rather than emitted under an unreachable name.
  for (const candidateSf of program.getSourceFiles()) {
    if (candidateSf === sf) continue;
    if (candidateSf.isDeclarationFile) continue;
    for (const stmt of candidateSf.statements) {
      let name: string | null = null;
      let parts: PartitionedMembers | null = null;
      if (ts.isInterfaceDeclaration(stmt)) {
        if (stmt.typeParameters?.length) continue;
        if (stmt.heritageClauses?.length) continue;
        name = stmt.name.text;
        parts = partition(stmt.members, candidateSf);
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        if (stmt.typeParameters?.length) continue;
        if (!ts.isTypeLiteralNode(stmt.type)) continue;
        name = stmt.name.text;
        parts = partition(stmt.type.members, candidateSf);
      }
      if (!name || !parts) continue;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      index.push({
        name,
        requiredFields: parts.required,
        optionalFields: parts.optional,
      });
    }
  }
  return index;
}

export interface NamedTypeIndex {
  /** Canonical structural-shape string → type name, for exact matches. */
  named: Map<string, string>;
  /** Required/optional field maps per named type, for subset matches. */
  subset: SubsetNamedTypeIndex;
}

/**
 * Unified named-type index with the scope decision owned in one place.
 * With a Program + filename → cross-file scope (imports + same-file);
 * otherwise, or when the file isn't in the Program, same-file only. Both
 * the exact-match (`named`) and subset-match (`subset`) views are built
 * together so callers no longer thread two indexes or branch on scope twice.
 *
 * The same-file pair shares one declaration filter; the two cross-file
 * traversals stay distinct on purpose — `named` walks `getSymbolsInScope`
 * while `subset` widens to every user source file (transitively-reachable
 * types), gated downstream by the emission-time scope check.
 */
export function buildNamedTypeIndex(
  source: string,
  program?: ts.Program,
  filename?: string,
): NamedTypeIndex {
  if (program && filename) {
    const named = buildCrossFileNamedTypeIndex(program, filename, source);
    const subset = buildCrossFileSubsetIndex(program, filename, source);
    if (named && subset) return { named, subset };
    // File not in the Program — fall through to same-file only.
  }
  return {
    named: buildSameFileNamedTypeIndex(source),
    subset: buildSameFileSubsetIndex(source),
  };
}

/**
 * Apply the named-type substitution to an emitted annotation type string.
 * Returns the named form when an exact canonical match exists; otherwise
 * returns the input unchanged.
 */
export function rewriteToNamedInScope(emitted: string, index?: NamedTypeIndex): string {
  const namedIndex = index?.named;
  const subsetIndex = index?.subset;
  if (!namedIndex && !subsetIndex) return emitted;
  const direct = namedIndex?.get(emitted);
  if (direct) return direct;
  // Subset matching only applies to object-literal types — without `{`
  // there's no structural shape to match against, and tampering with
  // unions or primitives just reformats them gratuitously.
  if (!subsetIndex || !emitted.includes("{")) return emitted;
  return rewriteToNamedRecursive(emitted, namedIndex, subsetIndex);
}

/**
 * Structured named-type index for subset matching. Where the
 * exact-match index just maps canonical-string → name, this carries the
 * per-field info needed for subset comparison:
 *
 *   - `requiredFields`: fields the named type declares without `?`. The
 *     observation must contain every one of these for a subset match.
 *   - `optionalFields`: fields declared with `?` (or the wider TS-level
 *     `| undefined` form). May be absent from the observation; if
 *     present, the type must match.
 *
 * Field types are stored as their canonical TS source text. Comparison
 * is exact-string after recursive rewrite of nested `{ ... }` shapes,
 * plus a small accommodation for `T | null` / `T | undefined` widening
 * matching `T` on the observation side.
 */
export type SubsetNamedTypeIndex = Array<{
  name: string;
  requiredFields: Map<string, string>;
  optionalFields: Map<string, string>;
}>;

/**
 * Recursive named-type rewrite. Bottom-up: rewrite nested `{ ... }`
 * substrings first, then try exact and subset matches at this level.
 *
 * Invariant: returns the input unchanged when no rewrite happened.
 * Reformats only when at least one named-type substitution applies,
 * so unions, ordering, and whitespace from the original emit are
 * preserved on the no-op path.
 *
 * Skips entries that don't contain `{` — there's no shape to subset-
 * match in primitives, named identifiers, or function-arrow types.
 */
function rewriteToNamedRecursive(
  emitted: string,
  namedIndex: Map<string, string> | undefined,
  subsetIndex: SubsetNamedTypeIndex,
): string {
  if (!emitted.includes("{")) return emitted;
  const trimmed = emitted.trim();
  // Array postfix
  if (trimmed.endsWith("[]") && !trimmed.endsWith("][]")) {
    const inner = trimmed.slice(0, -2);
    const rewritten = rewriteToNamedRecursive(inner, namedIndex, subsetIndex);
    if (rewritten === inner) return emitted;
    return rewritten + "[]";
  }
  // Top-level union: rewrite each branch; rejoin only if any branch
  // changed. Preserves the original separator format (`|` vs ` | `).
  const branches = splitTopLevelUnion(trimmed);
  if (branches.length > 1) {
    let anyChanged = false;
    const rewrittenBranches = branches.map((b) => {
      const r = rewriteToNamedRecursive(b, namedIndex, subsetIndex);
      if (r !== b) anyChanged = true;
      return r;
    });
    if (!anyChanged) return emitted;
    const separator = trimmed.includes(" | ") ? " | " : "|";
    return rewrittenBranches.join(separator);
  }
  // Generic-call form `Name<arg1, arg2, ...>`. Recurse
  // into each arg, reassemble if any arg changed. Covers Promise<X>,
  // Array<X>, Set<X>, Map<K, V>, Record<K, V>, Readonly<X>, Partial<X>
  // — anything matching `Identifier<args>` at the top level. The match
  // logic stays the same; only the recursion opens up.
  const generic = parseGenericForm(trimmed);
  if (generic) {
    const { name, args } = generic;
    let anyChanged = false;
    const rewrittenArgs = args.map((a) => {
      const r = rewriteToNamedRecursive(a, namedIndex, subsetIndex);
      if (r !== a) anyChanged = true;
      return r;
    });
    if (!anyChanged) return emitted;
    return name + "<" + rewrittenArgs.join(", ") + ">";
  }
  // Object literal: parse, recursively rewrite each value, then try matches.
  const parsed = parseObjectType(trimmed);
  if (parsed === null) return emitted;
  let anyFieldChanged = false;
  const rewrittenFields = new Map<string, string>();
  for (const [key, value] of parsed) {
    const r = rewriteToNamedRecursive(value, namedIndex, subsetIndex);
    if (r !== value) anyFieldChanged = true;
    rewrittenFields.set(key, r);
  }
  // Try exact match on the canonical form (after nested rewrites).
  if (namedIndex) {
    const canonical = canonicalizeObjectShape(rewrittenFields);
    const direct = namedIndex.get(canonical);
    if (direct) return direct;
  }
  // Subset match.
  const subsetMatch = findSubsetMatch(rewrittenFields, subsetIndex);
  if (subsetMatch) return subsetMatch;
  // No match: return original if no nested field changed; otherwise
  // reassemble with original key order preserved.
  if (!anyFieldChanged) return emitted;
  return reassembleObject(rewrittenFields);
}

/**
 * If the input is a single `Promise<X>` form, return
 * `X`. Otherwise return the input unchanged. Used by the async return-
 * type emit path to avoid `Promise<Promise<T>>` when the observed body
 * value is already a Promise. Also handles bare `Promise` (no type
 * argument) — ts-capture emits this when it couldn't determine T;
 * `expandCtorArity` would fill it as `Promise<unknown>` downstream,
 * so treating bare `Promise` as `Promise<unknown>` here unwraps to
 * `unknown`.
 */
export function unwrapOneLevelPromise(s: string): string {
  const trimmed = s.trim();
  if (trimmed === "Promise") return "unknown";
  const parsed = parseGenericForm(trimmed);
  if (parsed && parsed.name === "Promise" && parsed.args.length === 1) {
    return parsed.args[0];
  }
  return s;
}

/**
 * Parse a generic-call form `Name<arg1, arg2, ...>`
 * into its name and top-level argument strings. Splits args respecting
 * nested brackets so `Map<string, { k: T }>` doesn't split inside the
 * inner object. Returns null when the input isn't of this form (the
 * outer `<...>` must wrap the whole string).
 */
function parseGenericForm(s: string): { name: string; args: string[] } | null {
  if (!s.endsWith(">")) return null;
  const lt = findGenericOpener(s);
  if (lt === -1) return null;
  const name = s.slice(0, lt).trim();
  // The name must be a single identifier (no spaces, no operators).
  if (!/^[A-Za-z_$][\w$.]*$/.test(name)) return null;
  const inner = s.slice(lt + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
    else if ((ch === "," && depth === 0) || i === inner.length) {
      const segment = inner.slice(start, i).trim();
      if (segment) args.push(segment);
      start = i + 1;
    }
  }
  if (args.length === 0) return null;
  return { name, args };
}

/**
 * Find the position of the `<` that opens the OUTER generic argument
 * list — i.e. the `<` whose matching `>` is the last character. Walks
 * the bracket stack from the end. Returns -1 when the last `>` isn't
 * part of an outer generic (e.g. `T | U>` where `>` is part of a
 * nested form).
 */
function findGenericOpener(s: string): number {
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === ">" || ch === "}" || ch === "]" || ch === ")") depth++;
    else if (ch === "<" || ch === "{" || ch === "[" || ch === "(") {
      depth--;
      if (depth === 0 && ch === "<") return i;
    }
  }
  return -1;
}

/**
 * Canonical form for index lookup — sorted keys, `{ k: T, ... }`.
 * Matches buildSameFileNamedTypeIndex's canonicalization.
 */
function canonicalizeObjectShape(fields: Map<string, string>): string {
  if (fields.size === 0) return "{}";
  const sorted = [...fields.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return "{ " + sorted.map(([k, v]) => `${k}: ${v}`).join(", ") + " }";
}

/**
 * Reassemble an object shape preserving the input's key order — used
 * when nested rewrites changed some field values but the top-level
 * shape didn't match a named type.
 */
function reassembleObject(fields: Map<string, string>): string {
  if (fields.size === 0) return "{}";
  return "{ " + [...fields.entries()].map(([k, v]) => `${k}: ${v}`).join(", ") + " }";
}

/**
 * Subset match. Returns the named type's name when the observation:
 *   - contains every named-type REQUIRED field with a compatible type, AND
 *   - all of the observation's fields exist in the named type (required
 *     or optional), AND
 *   - field types are compatible (exact string match, or observation's
 *     non-union type matches named's `T | null` / `T | undefined`).
 *
 * Returns null on no match.
 */
function findSubsetMatch(
  observed: Map<string, string>,
  subsetIndex: SubsetNamedTypeIndex,
): string | null {
  for (const candidate of subsetIndex) {
    if (matchesSubset(observed, candidate)) return candidate.name;
  }
  return null;
}

function matchesSubset(
  observed: Map<string, string>,
  candidate: SubsetNamedTypeIndex[number],
): boolean {
  // Every observed field must exist in candidate (required ∪ optional)
  // with a compatible type.
  for (const [key, type] of observed) {
    const requiredType = candidate.requiredFields.get(key);
    const optionalType = candidate.optionalFields.get(key);
    const candidateType = requiredType ?? optionalType;
    if (candidateType === undefined) return false;
    if (!fieldTypeCompatible(type, candidateType)) return false;
  }
  // Every candidate REQUIRED field must exist in the observation.
  for (const key of candidate.requiredFields.keys()) {
    if (!observed.has(key)) return false;
  }
  return true;
}

/**
 * Field-type compatibility for subset matching:
 *   - Exact string equality after trim.
 *   - Observation's `T` matches candidate's `T | null` or `T | undefined`
 *     (the named type's union covers the observation's narrower observed
 *     value; common when ts-capture only observed the non-null/non-
 *     undefined branch this session).
 */
function fieldTypeCompatible(observed: string, candidate: string): boolean {
  const o = observed.trim();
  const c = candidate.trim();
  if (o === c) return true;
  const candidateBranches = splitTopLevelUnion(c).map((s) => s.trim());
  if (candidateBranches.length > 1 && candidateBranches.includes(o)) {
    // Observation's branch is one of the candidate's union members.
    return true;
  }
  return false;
}
