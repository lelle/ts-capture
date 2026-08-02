import { recognizeBuiltinShape } from "./builtin-shape.js";
import { rewriteCommonBase } from "./class-chain.js";
import { INFER_DEFAULTS, type InferOptions } from "./configuration.js";
import {
  isSubtype,
  lubAll,
  parseType,
  serializeType,
  serializeTypeAsUnionMember,
  type TypeNode,
  widenLiterals,
} from "./type-ir.js";

/**
 * Parse a top-level object type string into a key→value map. Accepts both
 * ts-capture's own emitted format (`{ a: number, b: string }` — comma + `: `)
 * AND declaration-style types from the TypeChecker's typeToString
 * (`{ a: number; b: string }` — semicolon, possibly no-space colon). The two
 * are a single grammar here so the merge engine and the apply-time verifier
 * (verify.ts) share one parser. Field-key modifiers (`readonly`, `?`) are kept
 * verbatim in the key; callers strip them. Nested braces/brackets/parens/angle
 * brackets are respected so commas, semicolons, and colons inside a value type
 * never split a field.
 */
export function parseObjectType(type: string): Map<string, string> | null {
  const trimmed = type.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return new Map();

  const pairs = new Map<string, string>();
  // Split on a top-level `,` or `;` (respecting nested brackets/parens/angles).
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ">" && inner[i - 1] !== "=") depth--;
    else if ((ch === "," && depth === 0) || (ch === ";" && depth === 0) || i === inner.length) {
      const segment = inner.slice(start, i).trim();
      if (segment) {
        // First top-level `:` splits key from value.
        let colonPos = -1;
        let d = 0;
        for (let j = 0; j < segment.length; j++) {
          const c = segment[j];
          if (c === "{" || c === "[" || c === "(" || c === "<") d++;
          else if (c === "}" || c === "]" || c === ")") d--;
          else if (c === ">" && segment[j - 1] !== "=") d--;
          else if (c === ":" && d === 0) {
            colonPos = j;
            break;
          }
        }
        if (colonPos === -1) return null; // not a valid object type
        pairs.set(segment.slice(0, colonPos).trim(), segment.slice(colonPos + 1).trim());
      }
      start = i + 1;
    }
  }

  return pairs;
}

function formatTypeSet(types: string[]): string {
  const sorted = [...new Set(types)].sort();
  return sorted.join(" | ");
}

/**
 * Merge multiple object type strings into a single type with optional properties.
 * Keys present in all observations are required; keys in only some are optional.
 * Returns null if the types cannot be merged (no overlapping keys).
 */
function mergeObjectTypes(
  objectTypes: string[],
  infer: InferOptions = INFER_DEFAULTS,
): string | null {
  const parsed = objectTypes.map(parseObjectType);
  if (parsed.some((p) => p === null)) return null;
  const maps = parsed as Map<string, string>[];

  // Collect all keys and their observation count + value types
  const allKeys = new Map<string, string[]>();
  for (const map of maps) {
    for (const [key, value] of map) {
      const existing = allKeys.get(key);
      if (existing) existing.push(value);
      else allKeys.set(key, [value]);
    }
  }

  // Check there's meaningful overlap: at least one key appears in more than one observation
  const totalObservations = maps.length;
  const nonEmptyMaps = maps.filter((m) => m.size > 0);
  if (nonEmptyMaps.length > 1) {
    const hasOverlap = [...allKeys.values()].some((v) => v.length > 1);
    if (!hasOverlap) return null;
  }

  // Discriminator detection — TS rule (src/compiler/types.ts:6129):
  //   Discriminant = HasNonUniformType | HasLiteralType.
  // A property is a discriminator iff it's non-uniform across the union
  // AND at least one member's type is a literal. We bail to a flat union
  // when that fires — preserves TS narrowing on the discriminator.
  //
  // The TS rule applies regardless of keyset symmetry. the earlier
  // implementation gated this check on a `hasNonSharedKeysAcrossNonEmpty`
  // condition, which silently merged identical-keyset literal discriminators
  // (`{kind:"a",v} | {kind:"b",v}`). Gap-B lifted the gate.
  //
  // Empty `{}` observations don't carry discriminator signal — they just
  // mean "this position was sometimes called with an empty object". So we
  // gate on nonEmptyMaps, not totalObservations.
  if (nonEmptyMaps.length >= 2) {
    for (const [, values] of allKeys) {
      if (values.length > 1) {
        const uniqueTypes = new Set(values);
        if (uniqueTypes.size > 1) {
          for (const t of uniqueTypes) {
            if (isLiteralTypeString(t)) return null;
          }
        }
      }
    }
  }

  // Build merged type
  const sortedKeys = [...allKeys.keys()].sort();
  const pairs = sortedKeys.map((key) => {
    const values = allKeys.get(key)!;
    const isOptional = values.length < totalObservations;
    const uniqueValues = mergeKeyValues(values, infer);
    if (!isOptional) {
      return `${key}: ${uniqueValues}`;
    }
    // When the parsed "key" came from a method-shape member
    // (`name(args): ret`), parseObjectType captured `name(args)` as the
    // key and `ret` as the value. Appending `?:` at the end yields
    // `name(args)?: ret` — invalid TS. The valid optional method-shape
    // syntax inserts `?` between the name and the args: `name?(args): ret`.
    const parenIdx = key.indexOf("(");
    if (parenIdx !== -1) {
      const name = key.slice(0, parenIdx);
      const args = key.slice(parenIdx);
      return `${name}?${args}: ${uniqueValues}`;
    }
    return `${key}?: ${uniqueValues}`;
  });

  if (pairs.length === 0) return "{}";
  return `{ ${pairs.join(", ")} }`;
}

/**
 * Build a value-type string for one key from N observations of that key.
 *
 * If every observation of this key is itself an object-literal type, try
 * to recursively merge them via mergeObjectTypes — that turns
 * `{ a: { x: T1 } } | { a: { x: T2 } }` into the much cleaner
 * `{ a: { x: T1 | T2 } }`. If the recursive merge bails (e.g. because the
 * inner shapes form a discriminated union), fall back to a flat union.
 *
 * Recursion is bounded by the depth of the type strings themselves, which
 * is bounded by getTypeName's maxDepth (default 5). No infinite loop risk.
 */
/**
 * Collapse a literal-form type-name back to its general type when the
 * corresponding `infer.literal.*` flag is OFF. Lets runtimes optimistically
 * emit literals (e.g. `'"hello"'`) and apply-time decide whether to keep
 * them or normalise to `string`/`number`/`boolean`.
 *
 * Recognises:
 *   - `'"foo"'`   → `'string'` (string literal)
 *   - `'42'`, `'-3.14'` → `'number'` (number literal)
 *   - `'true'`, `'false'` → `'boolean'` (boolean literal)
 *   - everything else passes through unchanged
 */
export function collapseLiteral(type: string, infer: InferOptions): string {
  // Fast top-level path (cheaper than parse+serialize): direct regex
  // match on the whole string when it's a bare literal.
  if (!infer.literal.string && /^"(?:[^"\\]|\\.)*"$/.test(type)) return "string";
  if (!infer.literal.number && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(type)) return "number";
  if (!infer.literal.boolean && (type === "true" || type === "false")) return "boolean";

  // Nested widening (mirrors TS's `getWidenedType`).
  // Only run when at least one widening flag is off AND the string has
  // structural characters that could carry nested literals. The cheap
  // pre-check avoids parsing trivial primitive strings.
  const allLiteralsPreserved =
    infer.literal.string && infer.literal.number && infer.literal.boolean;
  if (allLiteralsPreserved) return type;
  if (!/[{[<]|=>/.test(type)) return type; // no nested structure possible

  const node = parseType(type);
  if (node.tag === "raw") return type;
  const widened = widenLiterals(node, infer.literal);
  if (widened === node) return type;
  return serializeType(widened);
}

/**
 * Mirrors TS's `isLiteralType` for the textual type-strings we work with:
 * string literals (`"foo"`), number literals (`42`, `-3.14`), and the two
 * boolean literals. Excludes `null`/`undefined` — TS's `HasLiteralType`
 * flag does too (those have their own type-flag bits).
 *
 * Used by the discriminator-bail in `mergeObjectTypes` to align with
 * `Discriminant = HasNonUniformType | HasLiteralType`.
 */
function isLiteralTypeString(type: string): boolean {
  if (/^"(?:[^"\\]|\\.)*"$/.test(type)) return true;
  // Numeric literals: accept decimal AND scientific notation. The
  // runtime collector emits `String(value)` (value-walker.ts, resolveType)
  // which produces scientific form for very large/small finite numbers
  // — `String(1e21) === "1e+21"`.
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(type)) return true;
  return type === "true" || type === "false";
}

function mergeKeyValues(values: string[], infer: InferOptions = INFER_DEFAULTS): string {
  // Strip @sa chain markers (and optionally collapse class unions to a
  // common base) before any other handling — markers are an internal
  // encoding and must never leak into the output, and a value-position
  // class union is just as eligible for common-base collapse as a
  // top-level one.
  const collapsed = rewriteCommonBase(values, infer);
  const unique = [...new Set(collapsed)];
  if (unique.length === 1) return unique[0];

  const allObjects = unique.every((v) => parseObjectType(v) !== null);
  if (allObjects && infer.recursiveObjectMerge) {
    const merged = mergeObjectTypes(unique, infer);
    if (merged !== null) return merged;
  }
  return formatTypeSet(collapsed);
}

/**
 * Depth-aware split of a top-level union string. `{a:T}|{b:U}` splits to
 * `["{a:T}", "{b:U}"]`. Nested braces / brackets / parens / angle brackets
 * are skipped so unions inside object values don't break the split.
 */
export function splitTopLevelUnion(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
    else if (depth === 0 && ch === "|") {
      // Accept either `|` or ` | ` as the union separator
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

/**
 * Collapse cartesian-product object unions inside an array shape.
 *
 *   Array<{a:null,b:null} | {a:null,b:n} | {a:n,b:null} | {a:n,b:n}>
 *     ⇣
 *   Array<{a: null|n, b: null|n}>
 *
 * Same-keyset object literals inside an `Array<...>` are merged via
 * `mergeObjectTypes` so the user sees field-level unions instead of a
 * shape-level cartesian product. Discriminated unions (different keysets,
 * disagreeing on shared keys' types) are detected by `mergeObjectTypes`
 * and bail out — we keep the original union in that case.
 *
 * Also handles `{...}[]` shorthand at the top level.
 */
function compressArrayObjectUnion(t: string, infer: InferOptions): string {
  let inner: string;
  let arrayMatch = /^Array<(.+)>$/.exec(t);
  if (arrayMatch) {
    inner = arrayMatch[1]!;
  } else {
    // `{...}[]` shorthand: only handle when the element is a brace-shape
    // (otherwise `T[]` etc. has no union to collapse).
    arrayMatch = /^(\{.*\})\[\]$/.exec(t);
    if (!arrayMatch) return t;
    inner = arrayMatch[1]!;
  }

  const parts = splitTopLevelUnion(inner);
  if (parts.length < 2) return t;

  const objectParts: string[] = [];
  const otherParts: string[] = [];
  for (const p of parts) {
    if (parseObjectType(p) !== null) objectParts.push(p);
    else otherParts.push(p);
  }
  if (objectParts.length < 2) return t;

  const merged = mergeObjectTypes(objectParts, infer);
  if (merged === null) return t; // discriminated-union bail-out

  const finalParts = [...otherParts, merged].sort();
  // Wrap based on the SHAPE of the final element list, not on whether
  // there's a `|` somewhere inside an inner object value.
  if (finalParts.length === 1) {
    return `${finalParts[0]}[]`;
  }
  return `Array<${finalParts.join(" | ")}>`;
}

export function mergeTypes(types: string[], infer: InferOptions = INFER_DEFAULTS): string[] {
  // Class-hierarchy collapse runs first — it produces clean class names
  // that subsequent stages can treat as plain otherTypes. Skipping when
  // there's nothing to do (no @sa markers + flag off) is a no-op pass.
  const pre = types.map((t) => compressArrayObjectUnion(t, infer));
  const collapsed = rewriteCommonBase(pre, infer);

  const objectTypes: string[] = [];
  const arrayTypes: string[] = [];
  const otherTypes: string[] = [];

  for (const t of collapsed) {
    if (parseObjectType(t) !== null) {
      objectTypes.push(t);
    } else if (infer.crossSampleArrayMerge && isSimpleArrayType(t)) {
      arrayTypes.push(t);
    } else {
      otherTypes.push(t);
    }
  }

  // Object merge (today's behavior)
  let mergedObject: string | null = null;
  if (objectTypes.length >= 2) {
    mergedObject = mergeObjectTypes(objectTypes, infer);
    // When the legacy heuristic-stack bails (discriminator
    // detection or no-overlap), fall back to anti-unification. The
    // structural lub knows shapes the heuristics give up on. Verify
    // oracle still gates correctness downstream — a bad lub
    // result that introduces type errors gets dropped at apply time.
    if (mergedObject === null && infer.lubFallback) {
      mergedObject = lubFallbackMerge(objectTypes, infer);
    }
  }

  // Array merge (gated by infer.crossSampleArrayMerge)
  let mergedArray: string | null = null;
  if (arrayTypes.length >= 2) {
    mergedArray = mergeArrayTypes(arrayTypes);
  }

  // If neither group merged, return the post-collapse list (NOT the
  // original `types`) — `rewriteCommonBase` may have rewritten or
  // marker-stripped class observations even when object/array merge
  // didn't fire. Returning `types` here would silently leak `@sa`
  // markers into the apply output.
  const legacyResult =
    mergedObject === null && mergedArray === null
      ? collapsed
      : [
          ...otherTypes,
          ...(mergedObject !== null ? [mergedObject] : objectTypes),
          ...(mergedArray !== null ? [mergedArray] : arrayTypes),
        ];

  // IR-based post-processing to deliver the cross-syntax
  // wins the legacy partition can't:
  //   1. `T[]` and `Array<T>` are the same type — normalise + dedup.
  //   2. Subsumption: drop `string[]` when `Array<boolean | string>` is
  //      already in the union.
  //
  // Object merging stays in the legacy `mergeObjectTypes` because it
  // bakes in deliberate heuristics (discriminator-bail,
  // `recursiveObjectMerge` gate, class-collapse on nested values)
  // that anti-unification's pure structural lub doesn't preserve.
  // The post-pass operates on what the legacy step produced, so the
  // heuristics still get to run first.
  const deduped = irDedupUnion(legacyResult);

  // Structural-to-named recognition for common built-ins.
  // Runs AFTER irDedupUnion because the dedup may collapse near-duplicate
  // observations into a single shape — and the recognizer is most useful
  // on that canonical form.
  if (infer.recognizeBuiltinShapes) {
    return deduped.map((t) => maybeRewriteBuiltinShape(t));
  }
  return deduped;
}

/**
 * Anti-unification fallback for `mergeObjectTypes` bails.
 *
 * Three outcomes:
 *   - Lub structurally merges (single `object` node) → return its
 *     serialised form. The shape carries the shared-key optional
 *     merge that the legacy heuristic gave up on.
 *   - Lub bails to a flat union over DISJOINT objects (no key
 *     appears in more than one member) → return `"unknown"` with a
 *     polymorphic-position marker. Strong signal the position is
 *     genuinely generic; emitting the wide union would over-specify.
 *   - Lub returns anything else (non-disjoint union, raw, etc.) →
 *     return null, let the caller stay with the legacy flat-union
 *     fallback.
 *
 * Caller (`mergeTypes`) only invokes this when `mergeObjectTypes`
 * returned null AND `infer.lubFallback` is on.
 */
function lubFallbackMerge(objectTypes: string[], infer: InferOptions): string | null {
  const parsed = objectTypes.map(parseType);
  // If any observation failed to parse (raw node), fall back rather
  // than feed a raw node into lub — it can't anti-unify what it can't
  // model.
  if (parsed.some((p) => p.tag === "raw")) return null;
  const merged = lubAll(parsed);
  if (merged.tag === "object") {
    return serializeType(merged);
  }
  if (merged.tag === "union" && areAllDisjointObjects(merged.members)) {
    return infer.emitDiagnosticComments
      ? "unknown /* @ts-capture:polymorphic-position */"
      : "unknown";
  }
  return null;
}

/**
 * True when every member is an object node AND no key appears in
 * more than one member (truly disjoint shapes). Polymorphic-
 * position detection.
 */
function areAllDisjointObjects(members: TypeNode[]): boolean {
  if (members.length < 2) return false;
  const seenKeys = new Set<string>();
  for (const m of members) {
    if (m.tag !== "object") return false;
    for (const k of m.required.keys()) {
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
    }
    for (const k of m.optional.keys()) {
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
    }
  }
  return true;
}

/**
 * Parse `t`; if it recognises as a known built-in structural shape,
 * return the named-ref form (`Promise<unknown>`, ...). Otherwise pass
 * through unchanged.
 */
function maybeRewriteBuiltinShape(t: string): string {
  const node = parseTypeOrNull(t);
  if (node === null) return t;
  const rewritten = recognizeBuiltinShape(node);
  if (rewritten === null) return t;
  return serializeType(rewritten);
}

/**
 * IR-based dedup on a union member list. Parses every member; for any
 * that parse cleanly, run subsumption-aware dedup (drop members
 * subsumed by another) with cross-syntax normalisation (`T[]` and
 * `Array<T>` compare equal). Members that don't parse pass through
 * unchanged.
 *
 * When no member gets dropped, returns the ORIGINAL strings — avoids
 * round-tripping through parse → serialise (which would re-sort
 * object keys and change formatting where no semantic change
 * happened). This is the "narrow value-add" mode: only mutate when
 * we have a real subsumption win.
 *
 * unknown[] carve-out: `unknown[]` participates in subsumption only by
 * being kept, never as a subsumer of a concrete `T[]`. Ts-capture's
 * the downstream filter prefers to DROP `unknown[]` when paired
 * with a concrete array — the IR dedup would otherwise prefer the
 * broader `unknown[]` and lose the concrete observation. The carve-
 * out lets the downstream filter do its job.
 */
function irDedupUnion(types: string[]): string[] {
  if (types.length < 2) return types;
  const parsed: { text: string; node: TypeNode | null }[] = types.map((t) => ({
    text: t,
    node: parseTypeOrNull(t),
  }));

  let droppedAny = false;
  const kept: typeof parsed = [];
  for (const cur of parsed) {
    if (cur.node === null) {
      kept.push(cur);
      continue;
    }
    // Skip if a kept member already subsumes this one — but only when
    // the subsumer isn't `unknown[]` (the downstream filter prefers concrete).
    let subsumed = false;
    for (const k of kept) {
      if (k.node !== null && isSubtype(cur.node, k.node) && !isUnknownArray(k.node)) {
        subsumed = true;
        break;
      }
    }
    if (subsumed) {
      droppedAny = true;
      continue;
    }
    // Drop any previously-kept member this one subsumes (same carve-out).
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i];
      if (k.node !== null && isSubtype(k.node, cur.node) && !isUnknownArray(cur.node)) {
        kept.splice(i, 1);
        droppedAny = true;
      }
    }
    kept.push(cur);
  }

  if (!droppedAny) return types;
  // Caller (mergeTypes → sortedTypes.join("|") at the apply boundary)
  // builds a string-level union from these elements. Serialize each
  // node in union-member context so fn types get parenthesised — the
  // outer string-join is otherwise free to land a bare fn next to a
  // non-fn and produce a precedence-ambiguous result.
  return kept.map((k) => (k.node !== null ? serializeTypeAsUnionMember(k.node) : k.text));
}

function isUnknownArray(node: TypeNode): boolean {
  return node.tag === "array" && node.element.tag === "prim" && node.element.name === "unknown";
}

function parseTypeOrNull(t: string): TypeNode | null {
  const node = parseType(t);
  return node.tag === "raw" ? null : node;
}

const SIMPLE_ARRAY_RE = /^(?:[a-zA-Z_$][\w$]*\[\]|Array<[^<>]+>)$/;

function isSimpleArrayType(t: string): boolean {
  return SIMPLE_ARRAY_RE.test(t);
}

/**
 * Merge multiple array type observations into a single array with a unioned
 * element type. `number[]` + `string[]` → `Array<number | string>`. Gated
 * by `infer.crossSampleArrayMerge` since the merged form is sometimes
 * less helpful than `T[] | U[]` (e.g. when callers narrow by checking
 * the array element type).
 *
 * Returns null if any input isn't a recognised simple array type.
 */
function mergeArrayTypes(arrayTypes: string[]): string | null {
  const elements = new Set<string>();
  for (const t of arrayTypes) {
    const el = extractArrayElement(t);
    if (el === null) return null;
    // For `Array<T | U>`, split top-level union to flatten.
    for (const part of el.split(" | ")) {
      const trimmed = part.trim();
      if (trimmed && trimmed !== "unknown") elements.add(trimmed);
    }
  }
  if (elements.size === 0) return "unknown[]";
  if (elements.size === 1) return `${[...elements][0]}[]`;
  const sorted = [...elements].sort();
  return `Array<${sorted.join(" | ")}>`;
}

function extractArrayElement(t: string): string | null {
  if (t === "unknown[]") return "unknown";
  let m = /^([a-zA-Z_$][\w$]*)\[\]$/.exec(t);
  if (m) return m[1];
  m = /^Array<(.+)>$/.exec(t);
  if (m) return m[1];
  return null;
}
