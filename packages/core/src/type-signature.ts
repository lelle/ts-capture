// Pure type-string signature algebra. Every
// function here is a pure string→string (or value→string) transform with no
// dependency on the value walker, the collection context, or `typescript`.
// This is the single source of truth the @ts-capture/vite runtime snippet
// hand-mirrors today (see packages/vite/src/index.ts `__tscptr__getTypeName`);
// the equivalence guard lives in packages/vite/src/mirror-equivalence.spec.ts.
//
// No imports by design: a `ts.` reference or a walker call appearing here means
// a concern has leaked and belongs in value-walker.ts / collection-context.ts.

// Keys attached by ts-capture's own runtime collector. Walking globalThis
// under Vitest pulls these into observed types because the collector
// snippet installs `__tscptr__` and `__tscptr__*` helpers there. When the
// user has cast e.g. `window as WindowWithDataLayer`, apply would emit
// ts-capture internals as fields of the resulting type. Skip them at
// the type-walker level, not the snippet level, so callers can also use
// type-collector standalone.
export const TS_CAPTURE_INTERNAL_KEY = /^__tscptr__/;

/**
 * Coarse type fallback used when a fully-walked type-name exceeds
 * `maxAnnotationChars`. Keeps observation alive (otherwise apply
 * would emit nothing) but drops the shape.
 */
export function coarseTypeFallback(value: unknown): string {
  if (Array.isArray(value)) return "unknown[]";
  if (typeof value === "function") return "(...args: unknown[]) => unknown";
  if (typeof value === "object" && value !== null) {
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && ctorName !== "Object") return ctorName;
    return "Record<string, unknown>";
  }
  return "unknown";
}

export function getInheritanceChain(value: object): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let proto = Object.getPrototypeOf(value) as object | null;
  // Step past the value's own constructor — the chain captures the
  // ancestors only. Caller already has the most-derived class name.
  proto = proto ? (Object.getPrototypeOf(proto) as object | null) : null;
  while (proto && proto !== Object.prototype) {
    if (seen.has(proto)) break; // defensive: malformed prototype graph
    seen.add(proto);
    const ctor = (proto as { constructor?: { name?: string } }).constructor;
    const name = ctor?.name;
    if (name && name !== "Object") chain.push(name);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return chain;
}

/**
 * Pack a class name + inheritance chain into a type string that flows
 * transparently through apply's existing string-based merge stages.
 *
 * Format: ClassName followed by a marker comment containing the chain,
 * pipe-separated. The `@sa` marker (ts-capture ancestors) is unique
 * enough that real source comments won't false-match. The marker is
 * always emitted (even with an empty chain) so apply can distinguish
 * "this is a class observation" from "this is some other named type"
 * (`string`, `number`, etc.).
 */
export function encodeClassWithChain(name: string, chain: string[]): string {
  return `${name} /* @sa:${chain.join("|")} */`;
}

export function resolveFunctionType(fn: Function): string {
  let source: string;
  try {
    source = fn.toString();
  } catch {
    return "Function";
  }

  // Native functions: `function name() { [native code] }`
  if (source.includes("[native code]")) {
    // Bound functions: fn.name starts with "bound "
    if (fn.name.startsWith("bound ")) {
      return "(...args: unknown[]) => unknown";
    }
    return "Function";
  }

  // Class constructors: `class Foo { ... }`
  if (source.startsWith("class ")) {
    const name = fn.name || "anonymous";
    return `typeof ${name}`;
  }

  // Detect async and generator modifiers
  const isAsync = source.startsWith("async ");
  const isGenerator = source.includes("function*") || source.includes("async function*");

  let argsStr = source.split("=>")[0];
  argsStr = argsStr.includes("(") ? (argsStr.match(/\(.*?\)/g) || ["()"])[0] : `(${argsStr})`;

  // Split on top-level commas only — naive .split(",") would break a
  // destructured param like ({a, b}) into ["{a", " b}"], which downstream
  // produces invalid type signatures like `(aObject: {a: unknown}, b}: unknown)`.
  // We track brace/bracket/paren depth and split only when depth == 0.
  const inner = argsStr.replace(/^\(|\)$/g, "");
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (current.trim() !== "") args.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") args.push(current);

  const VALID_IDENT = /^[a-zA-Z_$][\w$]*$/;
  const typedArgs = args.map((arg, idx) => {
    let [name] = arg.split("=");
    name = name.trim();

    // Defense against mangled / overridden toString that yields a CALL
    // expression as the first paren group (e.g. native wrappers, jsdom
    // synthetic globals). Bare numerics and quoted strings are valid
    // call args but invalid parameter names — emitting them produces
    // unparseable TypeScript like `(1: unknown, "/path": unknown) => …`.
    // Fall back to positional argN — same shape as instrument's own
    // fallbacks for unobservable param shapes.
    //
    // A real param starts with `[` (array destructure), `{` (object
    // destructure), `...` (rest), or matches the identifier pattern.
    // Anything else is mangled output.
    const isShapelike =
      name.startsWith("[") ||
      name.startsWith("{") ||
      name.startsWith("...") ||
      VALID_IDENT.test(name);
    if (!isShapelike) {
      return `arg${idx}: unknown`;
    }

    if (name.includes("[")) {
      // Destructured array param: [a, b] → "arg{idx}Array: unknown".
      // Concatenating field names (`abArray`) produces an
      // unreadable monster identifier once field count grows. Use a
      // positional anonymous name (`arg0Array`) for multi-field, but
      // preserve the single-name shape (`aArray`) when there's exactly
      // one valid binding — preserves human-readable single-case output.
      const fields = name
        .replace(/[[\]]/g, "")
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f !== "");
      const concat = fields.length === 1 && VALID_IDENT.test(fields[0]) ? fields[0] : `arg${idx}`;
      return `${concat}Array: unknown`;
    }
    if (name.includes("{")) {
      // Destructured object param: {a, b} → "arg{idx}Object: {a: unknown, b: unknown}"
      // Rest field {a, ...rest} → "arg{idx}Object: {a: unknown, [k: string]: unknown}"
      // Rename {prop: local} → use the local binding name in both the
      // emitted param-name and the inner shape, so the colon in
      // `prop: local` doesn't leak through into ungrammatical types
      // like `(request: eObject: {request: e: unknown})`.
      const fields = name
        .replace(/[{}]/g, "")
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f !== "");
      const namedFields = fields.filter((f) => !f.startsWith("..."));
      const hasRest = fields.some((f) => f.startsWith("..."));
      // Strip rename syntax: `prop: local` → `local`. The local is what
      // the function body actually binds; the source-side prop name is
      // not addressable from outside.
      const localNames = namedFields.map((f) => {
        const colonIdx = f.indexOf(":");
        return colonIdx >= 0 ? f.slice(colonIdx + 1).trim() : f;
      });
      // Single-field with a valid local identifier keeps its name (so
      // `({ a })` → `aObject: {a: unknown}` and `({ request: e })` →
      // `eObject: {e: unknown}`). Anything else (multi-field, rest-only,
      // mangled identifiers) falls back to a positional anonymous name.
      const paramName =
        localNames.length === 1 && !hasRest && VALID_IDENT.test(localNames[0])
          ? localNames[0]
          : `arg${idx}`;
      const inner = [
        ...localNames.map((f) => `${f}: unknown`),
        ...(hasRest ? ["[k: string]: unknown"] : []),
      ].join(", ");
      return `${paramName}Object: {${inner}}`;
    }
    if (name.includes("...")) {
      return `${name}Array: unknown[]`;
    }

    return `${name}: unknown`;
  });

  let returnType = "unknown";
  if (isAsync && isGenerator) returnType = "AsyncGenerator<unknown>";
  else if (isGenerator) returnType = "Generator<unknown>";
  else if (isAsync) returnType = "Promise<unknown>";

  return `(${typedArgs.join(", ")}) => ${returnType}`;
}

export function formatTypeSet(types: Set<string>, fallback: string): string {
  if (types.size === 0) return fallback;
  if (types.size === 1) return [...types][0];
  return [...types].sort().join(" | ");
}

/**
 * Rewrites a function-arrow shape into TS method-declaration syntax
 * when the value is a top-level function-arrow. Returns null when
 * the type isn't a function-arrow at the top level (a nested arrow,
 * a non-function shape, etc.).
 *
 * `(args) => ret` becomes `key(args): ret`. The leading `(` must
 * paren-balance to the start of ` => `, so nested arrows in args
 * (`(cb: () => void) => unknown`) are handled correctly: only the
 * outer arrow is rewritten, the inner stays property-shape.
 */
export function tryConvertToMethodShape(valueType: string, key: string): string | null {
  if (!valueType.startsWith("(")) return null;
  let depth = 0;
  for (let i = 0; i < valueType.length; i++) {
    const c = valueType[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        const rest = valueType.slice(i + 1);
        if (rest.startsWith(" => ")) {
          const args = valueType.slice(1, i);
          const returnType = rest.slice(4);
          return `${key}(${args}): ${returnType}`;
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Replace the return type of either a top-level function-arrow type OR
 * an object-member function-shape with `newReturn`, but only when the
 * existing return type is the generic `unknown` placeholder.
 *
 * Two cases:
 *   - Top-level function: `(args) => unknown` → `(args) => <newReturn>`. Used
 *     when the param is non-destructured (e.g. `function foo(cb) { cb(x); }`,
 *     where the param value's type is the function shape directly).
 *   - Object member: `{ memberName(args): unknown, ... }` → `{ memberName(args): <newReturn>, ... }`.
 *     Used when the param is a destructured object whose property is the
 *     callback (e.g. `function Card({ render }) { render(t); }`).
 *
 * Conservative: only substitutes when the existing return is literally
 * `unknown`. If a prior cross-ref (recordedFunctions / objectMemberFns)
 * already populated a specific return type from the parent's observation,
 * trust it and leave it alone. Param-return observations are a fallback,
 * not an override.
 *
 * Returns the original string unchanged when no `unknown`-return slot is found.
 */
/**
 * From `retStart`, return the end index of a return type within `typeStr`: the
 * first top-level `,` or object-closing `}` (paren/brace depth tracked). When a
 * `}` closes the outer object type, trailing spaces are trimmed —
 * `resolveObjectType` always emits `{ ... }` with a trailing space.
 */
function findReturnTypeEnd(typeStr: string, retStart: number): number {
  let retEnd = retStart;
  let parenD = 0;
  let braceD = 0;
  for (let i = retStart; i < typeStr.length; i++) {
    const c = typeStr[i];
    if (c === "(") parenD++;
    else if (c === ")") parenD--;
    else if (c === "{") braceD++;
    else if (c === "}") {
      if (braceD === 0) {
        retEnd = i;
        break;
      }
      braceD--;
    } else if (c === "," && parenD === 0 && braceD === 0) {
      retEnd = i;
      break;
    }
    retEnd = i + 1;
  }
  if (retEnd < typeStr.length && typeStr[retEnd] === "}") {
    while (retEnd > retStart && typeStr[retEnd - 1] === " ") retEnd--;
  }
  return retEnd;
}

export function applyParamReturnUpgrade(
  typeStr: string,
  memberName: string,
  observedReturnTypes: string[],
): string {
  if (observedReturnTypes.length === 0) return typeStr;
  const newReturn = [...new Set(observedReturnTypes)].sort().join(" | ");

  // Case A: top-level function arrow `(args) => unknown`. Find the depth-0
  // `)` that closes the args list and check the trailing return is `unknown`.
  if (typeStr.startsWith("(")) {
    let depth = 0;
    for (let i = 0; i < typeStr.length; i++) {
      const c = typeStr[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          const rest = typeStr.slice(i + 1);
          if (rest === " => unknown") {
            return typeStr.slice(0, i + 1) + " => " + newReturn;
          }
          break;
        }
      }
    }
  }

  // Case B: object-member function-shape `memberName(args): unknown`.
  // Search for `<space>memberName(` (start of an object member), paren-
  // balance to the `)`, require `: ` after, then check the return type
  // ends at depth-0 `,` or `}` and is `unknown` literally.
  const searchToken = `${memberName}(`;
  let searchFrom = 0;
  while (searchFrom < typeStr.length) {
    const idx = typeStr.indexOf(searchToken, searchFrom);
    if (idx === -1) break;
    if (idx > 0 && typeStr[idx - 1] !== " ") {
      searchFrom = idx + 1;
      continue;
    }
    const openParen = idx + searchToken.length - 1;
    let depth = 0;
    let argsEnd = -1;
    for (let i = openParen; i < typeStr.length; i++) {
      if (typeStr[i] === "(") depth++;
      else if (typeStr[i] === ")") {
        if (--depth === 0) {
          argsEnd = i;
          break;
        }
      }
    }
    if (argsEnd === -1) break;
    if (!typeStr.slice(argsEnd + 1).startsWith(": ")) {
      searchFrom = idx + 1;
      continue;
    }
    const retStart = argsEnd + 3;
    const retEnd = findReturnTypeEnd(typeStr, retStart);
    const existingReturn = typeStr.slice(retStart, retEnd);
    if (existingReturn === "unknown") {
      return typeStr.slice(0, retStart) + newReturn + typeStr.slice(retEnd);
    }
    // Specific return already present — don't override. Keep searching in case
    // there's another occurrence of the same member name (rare).
    searchFrom = retEnd;
  }

  return typeStr;
}

/**
 * Replaces the method-shape entry for `memberName` inside an object type string
 * with the full signature derived from `sig` (arrow form). Returns the original
 * string unchanged when the member isn't found or `sig` isn't a function arrow.
 */
export function upgradeObjectMemberFn(typeStr: string, memberName: string, sig: string): string {
  const newMethodShape = tryConvertToMethodShape(sig, memberName);
  if (newMethodShape === null) return typeStr;

  const searchToken = `${memberName}(`;
  let searchFrom = 0;
  while (searchFrom < typeStr.length) {
    const idx = typeStr.indexOf(searchToken, searchFrom);
    if (idx === -1) break;

    // Token must be preceded by `{ ` or `, ` (start of an object member)
    if (idx > 0 && typeStr[idx - 1] !== " ") {
      searchFrom = idx + 1;
      continue;
    }

    // Paren-balance to find the closing `)` of the args list
    const openParen = idx + searchToken.length - 1;
    let depth = 0;
    let argsEnd = -1;
    for (let i = openParen; i < typeStr.length; i++) {
      if (typeStr[i] === "(") depth++;
      else if (typeStr[i] === ")") {
        if (--depth === 0) {
          argsEnd = i;
          break;
        }
      }
    }
    if (argsEnd === -1) break;

    // Must be followed by `: `
    if (!typeStr.slice(argsEnd + 1).startsWith(": ")) {
      searchFrom = idx + 1;
      continue;
    }

    // Find the end of the return type: stop at `,` or `}` at depth 0
    const retStart = argsEnd + 3; // skip `: `
    const retEnd = findReturnTypeEnd(typeStr, retStart);

    return typeStr.slice(0, idx) + newMethodShape + typeStr.slice(retEnd);
  }
  return typeStr;
}

/** Check if a type string is a generic function signature like `(x: unknown) => unknown` */
export function isGenericFunctionType(type: string): boolean {
  return /^\(.*\) => /.test(type) && (type.includes(": unknown") || type === "() => unknown");
}

/** Build a function signature string from collected parameter and return type entries. */
export function buildFunctionSignature(
  params: Array<{ name: string; types: string[] }>,
  returnTypes: string[],
  isAsync: boolean,
): string {
  const paramParts = params.map((p) => {
    const types = [...new Set(p.types)].sort();
    return `${p.name}: ${types.join(" | ")}`;
  });

  let retType: string;
  if (returnTypes.length === 0) {
    retType = "unknown";
  } else {
    const unique = [...new Set(returnTypes)].sort();
    // Widen sole-undefined return to void, matching the apply-side
    // rule. The arrow's own return-type annotation widens; the
    // receiver's prop-shape must too, otherwise the receiver expects
    // `cb(...) => undefined` while callers provide `cb(...) => void`
    // and TS rejects the variance (TS2322). Union returns like
    // `string | undefined` stay as-is — `undefined` is meaningful
    // when it's one branch.
    if (unique.length === 1 && unique[0] === "undefined") {
      retType = "void";
    } else {
      retType = unique.join(" | ");
    }
  }
  if (isAsync && !retType.startsWith("Promise<")) {
    retType = `Promise<${retType}>`;
  }

  return `(${paramParts.join(", ")}) => ${retType}`;
}
