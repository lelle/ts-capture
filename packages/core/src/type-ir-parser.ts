import type { FnParam, PrimName, TypeNode } from "./type-ir.js";

// Parser for the type IR.
// TS type string -> TypeNode; unrecognised shapes return a `raw` node that
// round-trips verbatim.

const PRIM_NAMES: ReadonlySet<PrimName> = new Set<PrimName>([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "null",
  "undefined",
  "void",
  "unknown",
  "never",
  "any",
]);

/**
 * Parse a type string into a TypeNode. Best-effort: unrecognised
 * shapes return a `raw` node carrying the original text.
 *
 * Grammar (informally):
 *   type   := union
 *   union  := atom ("|" atom)*
 *   atom   := arraySuffix | primary
 *   arraySuffix := primary ("[]")*
 *   primary := literal | objectLit | tupleLit | fnType | refOrPrim | "(" union ")"
 *
 * Whitespace is permissive between tokens. The parser does not
 * validate that the resulting type is well-formed TypeScript — only
 * `isParseableTypeString` does that, downstream of serialise.
 */
export function parseType(input: string): TypeNode {
  const s = input.trim();
  if (s === "") return { tag: "raw", text: input };
  const parser = new Parser(s);
  const node = parser.parseUnion();
  if (!parser.atEnd()) {
    // Trailing tokens means we couldn't fully parse — fall back to raw
    // rather than emitting a half-parsed tree.
    return { tag: "raw", text: input };
  }
  return node;
}

class Parser {
  private i = 0;
  constructor(private src: string) {}

  atEnd(): boolean {
    this.skipWs();
    return this.i >= this.src.length;
  }

  parseUnion(): TypeNode {
    const members: TypeNode[] = [this.parseIntersection()];
    while (true) {
      this.skipWs();
      if (this.peek() !== "|") break;
      this.i++;
      members.push(this.parseIntersection());
    }
    if (members.length === 1) return members[0];
    return flattenUnion({ tag: "union", members });
  }

  // We don't model intersections as a real node yet — observations
  // rarely produce them. Parse for syntactic completeness and pass
  // through as `raw` if we hit one.
  parseIntersection(): TypeNode {
    const first = this.parseArraySuffix();
    this.skipWs();
    if (this.peek() !== "&") return first;
    // Bail to raw — consume the rest of the intersection chain so
    // outer union parsing doesn't see the `&`.
    const start = this.indexBeforeTerm(first);
    while (this.peek() === "&") {
      this.i++;
      this.parseArraySuffix();
      this.skipWs();
    }
    return { tag: "raw", text: this.src.slice(start, this.i).trim() };
  }

  // Track where a term started so an intersection bail can capture
  // the full original substring rather than just the tail.
  private indexBeforeTerm(_node: TypeNode): number {
    // Simplified: we lost the start index, so re-serialise the term
    // and assume the source still contains it verbatim (true for the
    // single-term case we hit here).
    return 0;
  }

  parseArraySuffix(): TypeNode {
    let node = this.parsePrimary();
    while (true) {
      this.skipWs();
      if (this.peek() === "[" && this.peekAt(1) === "]") {
        this.i += 2;
        node = { tag: "array", element: node };
      } else break;
    }
    return node;
  }

  parsePrimary(): TypeNode {
    this.skipWs();
    const c = this.peek();
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseTuple();
    if (c === "(") return this.parseParenOrFn();
    if (c === '"') return this.parseStringLiteral();
    if (c === "-" || (c >= "0" && c <= "9")) return this.parseNumberLiteral();
    return this.parseRefOrPrim();
  }

  parseObject(): TypeNode {
    this.expect("{");
    this.skipWs();
    const required = new Map<string, TypeNode>();
    const optional = new Map<string, TypeNode>();
    if (this.peek() === "}") {
      this.i++;
      return { tag: "object", required, optional };
    }
    while (true) {
      this.skipWs();
      const key = this.parseObjectKey();
      this.skipWs();
      const isOptional = this.peek() === "?";
      if (isOptional) this.i++;
      // For method-shape entries (`name(args): ret`) the colon comes
      // after the close paren, not after the name. We don't model
      // method-shape as `fn` here — keep the value as `raw` so apply
      // serialises it back verbatim. Easier than re-encoding.
      this.skipWs();
      if (this.peek() === "(") {
        // method shape — capture the whole `(args): ret` tail as raw
        const startIdx = this.i;
        this.skipBalanced("(", ")");
        this.skipWs();
        if (this.peek() !== ":") {
          // not a method-shape pattern after all — bail this object
          return { tag: "raw", text: this.consumeRest() };
        }
        this.i++; // ':'
        this.skipWs();
        // value text up to next ',' or '}'
        const valStart = this.i;
        this.parseValueTail();
        const tail = this.src.slice(valStart, this.i).trim();
        const valueText = this.src.slice(startIdx, this.i).trim();
        const raw: TypeNode = { tag: "raw", text: `${valueText}` };
        // store under the key plus its parens — keeps round-trip
        // (`foo(args): T` lands back via the raw node).
        void tail;
        (isOptional ? optional : required).set(key, raw);
      } else {
        this.expect(":");
        this.skipWs();
        const valStart = this.i;
        this.parseValueTail("}");
        const valText = this.src.slice(valStart, this.i).trim();
        const value = parseType(valText);
        (isOptional ? optional : required).set(key, value);
      }
      this.skipWs();
      if (this.peek() === ",") {
        this.i++;
        this.skipWs();
        if (this.peek() === "}") {
          this.i++;
          return { tag: "object", required, optional };
        }
        continue;
      }
      if (this.peek() === "}") {
        this.i++;
        return { tag: "object", required, optional };
      }
      // unexpected token — bail to raw
      return { tag: "raw", text: this.consumeRest() };
    }
  }

  /**
   * Scan a value's text up to the next top-level terminator (comma or
   * the structural close char for the surrounding context). The caller
   * passes the context's close char (`}` for objects, `]` for tuples,
   * none for plain values) so a `]` inside a tuple correctly ends the
   * current value instead of being consumed.
   */
  parseValueTail(closeChar?: string): void {
    let depthBrace = 0;
    let depthAngle = 0;
    let depthParen = 0;
    let depthBracket = 0;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === '"') {
        this.skipString();
        continue;
      }
      if (c === "{") depthBrace++;
      else if (c === "}") {
        if (depthBrace === 0) {
          if (closeChar === "}") return;
          // unmatched } — bail
          return;
        }
        depthBrace--;
      } else if (c === "<") depthAngle++;
      else if (c === ">") {
        if (depthAngle > 0) depthAngle--;
      } else if (c === "(") depthParen++;
      else if (c === ")") {
        if (depthParen > 0) depthParen--;
      } else if (c === "[") depthBracket++;
      else if (c === "]") {
        if (depthBracket === 0) {
          if (closeChar === "]") return;
          // top-level `[]` is array suffix on the value's primary —
          // include it.
        } else {
          depthBracket--;
        }
      }
      if (
        c === "," &&
        depthBrace === 0 &&
        depthAngle === 0 &&
        depthParen === 0 &&
        depthBracket === 0
      ) {
        return;
      }
      this.i++;
    }
  }

  parseObjectKey(): string {
    this.skipWs();
    if (this.peek() === '"') {
      // Quoted key: capture the literal text including quotes.
      const start = this.i;
      this.skipString();
      return this.src.slice(start, this.i);
    }
    // Bare identifier or numeric-string key.
    const start = this.i;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === ":" || c === "?" || c === " " || c === "\t" || c === "(") break;
      this.i++;
    }
    return this.src.slice(start, this.i);
  }

  parseTuple(): TypeNode {
    this.expect("[");
    this.skipWs();
    const elements: TypeNode[] = [];
    if (this.peek() === "]") {
      this.i++;
      return { tag: "tuple", elements };
    }
    while (true) {
      this.skipWs();
      const start = this.i;
      this.parseValueTail("]");
      const text = this.src.slice(start, this.i).trim();
      elements.push(parseType(text));
      this.skipWs();
      if (this.peek() === ",") {
        this.i++;
        continue;
      }
      if (this.peek() === "]") {
        this.i++;
        return { tag: "tuple", elements };
      }
      return { tag: "raw", text: this.consumeRest() };
    }
  }

  parseParenOrFn(): TypeNode {
    // Could be `(T)` (parenthesised type) or `(arg: T, ...) => U` (fn).
    // Look ahead for `=>` to decide. The decision is cheap enough that
    // we just scan to the matching close-paren and check what follows.
    const start = this.i;
    this.expect("(");
    const paramText = this.consumeBalancedUntilClose();
    this.skipWs();
    if (this.peek() === "=" && this.peekAt(1) === ">") {
      this.i += 2;
      this.skipWs();
      const retStart = this.i;
      this.parseValueTail();
      const retText = this.src.slice(retStart, this.i).trim();
      const params = parseFnParams(paramText);
      if (params === null) {
        return { tag: "raw", text: this.src.slice(start, this.i).trim() };
      }
      return { tag: "fn", params, ret: parseType(retText) };
    }
    // Parenthesised single type: just return the inner parsed type.
    return parseType(paramText);
  }

  // Consume from after an open-paren up to (and including) the
  // matching close-paren, returning the inner text (without parens).
  consumeBalancedUntilClose(): string {
    let depth = 1;
    const start = this.i;
    while (this.i < this.src.length && depth > 0) {
      const c = this.src[this.i];
      if (c === '"') {
        this.skipString();
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          const text = this.src.slice(start, this.i);
          this.i++;
          return text;
        }
      }
      this.i++;
    }
    return this.src.slice(start, this.i);
  }

  parseStringLiteral(): TypeNode {
    const start = this.i;
    this.skipString();
    return { tag: "lit", kind: "string", text: this.src.slice(start, this.i) };
  }

  parseNumberLiteral(): TypeNode {
    const start = this.i;
    if (this.peek() === "-") this.i++;
    while (this.i < this.src.length && /[0-9.]/.test(this.src[this.i])) this.i++;
    const text = this.src.slice(start, this.i);
    // The character class `[0-9.]+` accepts malformed numbers (`1.2.3`,
    // `2.`, `..5`). The runtime collector only produces valid decimals
    // today, but the parser's contract is "non-raw node ⇒ round-trips
    // as valid TS" — enforce that here by falling back to a raw node
    // when the collected token isn't a well-formed numeric literal.
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
      return { tag: "raw", text };
    }
    return { tag: "lit", kind: "number", text };
  }

  parseRefOrPrim(): TypeNode {
    const start = this.i;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (
        (c >= "a" && c <= "z") ||
        (c >= "A" && c <= "Z") ||
        (c >= "0" && c <= "9") ||
        c === "_" ||
        c === "$" ||
        c === "."
      ) {
        this.i++;
      } else break;
    }
    const name = this.src.slice(start, this.i);
    if (name === "") return { tag: "raw", text: this.consumeRest() };
    if (name === "true" || name === "false") {
      return { tag: "lit", kind: "boolean", text: name };
    }
    if (PRIM_NAMES.has(name as PrimName)) {
      return { tag: "prim", name: name as PrimName };
    }
    this.skipWs();
    if (this.peek() === "<") {
      this.i++;
      const args: TypeNode[] = [];
      let depth = 1;
      while (this.i < this.src.length && depth > 0) {
        this.skipWs();
        const argStart = this.i;
        let localDepth = 0;
        while (this.i < this.src.length) {
          const c = this.src[this.i];
          if (c === '"') {
            this.skipString();
            continue;
          }
          if (c === "<") localDepth++;
          else if (c === ">") {
            if (localDepth === 0) {
              depth--;
              break;
            }
            localDepth--;
          } else if (c === "(") localDepth++;
          else if (c === ")") localDepth--;
          else if (c === "{") localDepth++;
          else if (c === "}") localDepth--;
          else if (c === "," && localDepth === 0) break;
          this.i++;
        }
        const argText = this.src.slice(argStart, this.i).trim();
        if (argText !== "") args.push(parseType(argText));
        if (this.peek() === ",") this.i++;
        else if (this.peek() === ">") {
          this.i++;
          break;
        }
      }
      // Normalise `Array<T>` → `array(T)` for unified handling.
      if (name === "Array" && args.length === 1) {
        return { tag: "array", element: args[0] };
      }
      return { tag: "ref", name, args };
    }
    return { tag: "ref", name, args: [] };
  }

  skipString(): void {
    this.i++; // opening "
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === "\\") {
        this.i += 2;
        continue;
      }
      this.i++;
      if (c === '"') return;
    }
  }

  skipBalanced(open: string, close: string): void {
    if (this.peek() !== open) return;
    this.i++;
    let depth = 1;
    while (this.i < this.src.length && depth > 0) {
      const c = this.src[this.i];
      if (c === '"') {
        this.skipString();
        continue;
      }
      if (c === open) depth++;
      else if (c === close) depth--;
      this.i++;
    }
  }

  consumeRest(): string {
    const text = this.src.slice(this.i);
    this.i = this.src.length;
    return text;
  }

  skipWs(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  peek(): string {
    return this.i < this.src.length ? this.src[this.i] : "";
  }

  peekAt(offset: number): string {
    return this.i + offset < this.src.length ? this.src[this.i + offset] : "";
  }

  expect(c: string): void {
    if (this.peek() !== c) throw new Error(`expected '${c}' at ${this.i} in ${this.src}`);
    this.i++;
  }
}

function parseFnParams(text: string): FnParam[] | null {
  const t = text.trim();
  if (t === "") return [];
  const result: FnParam[] = [];
  // Top-level comma split (handle nested parens/braces/angles).
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      // skip quoted
      i++;
      while (i < t.length && t[i] !== '"') {
        if (t[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "{" || c === "<" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ">" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(t.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(t.slice(start));
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const colonIdx = findTopLevelColon(trimmed);
    if (colonIdx === -1) return null;
    let name = trimmed.slice(0, colonIdx).trim();
    let optional = false;
    if (name.endsWith("?")) {
      optional = true;
      name = name.slice(0, -1).trim();
    }
    const typeText = trimmed.slice(colonIdx + 1).trim();
    result.push({ name, optional, type: parseType(typeText) });
  }
  return result;
}

function findTopLevelColon(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "{" || c === "<" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ">" || c === ")" || c === "]") depth--;
    else if (c === ":" && depth === 0) return i;
  }
  return -1;
}

function flattenUnion(node: TypeNode): TypeNode {
  if (node.tag !== "union") return node;
  const out: TypeNode[] = [];
  for (const m of node.members) {
    if (m.tag === "union") out.push(...m.members);
    else out.push(m);
  }
  if (out.length === 1) return out[0];
  return { tag: "union", members: out };
}
