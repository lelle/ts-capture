import type { TypeNode } from "./type-ir.js";

// Serializer for the type IR.
// TypeNode -> canonical TS type string, plus literal widening. Independent of
// the parser and the lub engine.

/**
 * Render a TypeNode back to a TS-compatible string. Output is
 * normalised: object keys sorted, union members deduped + sorted by
 * stringified form, `Array<T>` always rendered as `T[]` for primitive
 * elements and `Array<T>` for complex ones (matches the existing
 * apply heuristic for readability).
 */
export function serializeType(node: TypeNode): string {
  return serializeInContext(node, "top");
}

/**
 * Recursive literal-widening. For each `lit` node in the tree, replace
 * with its base `prim` when the corresponding flag is OFF. Other nodes
 * pass through, recursing into their children. TS's
 * `getWidenedType` analogue (TS widens literals into base types in
 * inference contexts).
 *
 * Mirrors `collapseLiteral`'s top-level checks but extends them into
 * nested shapes: object property values, array elements, tuple
 * elements, ref type-args, fn params + return. Unchanged when all
 * three literal flags are on.
 */
export interface LiteralWideningFlags {
  string: boolean;
  number: boolean;
  boolean: boolean;
}

export function widenLiterals(node: TypeNode, keep: LiteralWideningFlags): TypeNode {
  // Preserve reference identity when no widening fires anywhere in the
  // subtree — callers (apply-types.ts `collapseLiteral`) use `===`
  // identity to skip a serialize round-trip that would otherwise
  // re-sort object keys and re-format the type.
  switch (node.tag) {
    case "lit":
      if (node.kind === "string" && !keep.string) return { tag: "prim", name: "string" };
      if (node.kind === "number" && !keep.number) return { tag: "prim", name: "number" };
      if (node.kind === "boolean" && !keep.boolean) return { tag: "prim", name: "boolean" };
      return node;
    case "array": {
      const element = widenLiterals(node.element, keep);
      return element === node.element ? node : { tag: "array", element };
    }
    case "tuple": {
      let changed = false;
      const elements = node.elements.map((e) => {
        const w = widenLiterals(e, keep);
        if (w !== e) changed = true;
        return w;
      });
      return changed ? { tag: "tuple", elements } : node;
    }
    case "object": {
      let changed = false;
      const required = new Map<string, TypeNode>();
      for (const [k, v] of node.required) {
        const w = widenLiterals(v, keep);
        if (w !== v) changed = true;
        required.set(k, w);
      }
      const optional = new Map<string, TypeNode>();
      for (const [k, v] of node.optional) {
        const w = widenLiterals(v, keep);
        if (w !== v) changed = true;
        optional.set(k, w);
      }
      return changed ? { tag: "object", required, optional } : node;
    }
    case "ref": {
      let changed = false;
      const args = node.args.map((a) => {
        const w = widenLiterals(a, keep);
        if (w !== a) changed = true;
        return w;
      });
      return changed ? { tag: "ref", name: node.name, args } : node;
    }
    case "fn": {
      let changed = false;
      const params = node.params.map((p) => {
        const w = widenLiterals(p.type, keep);
        if (w === p.type) return p;
        changed = true;
        return { name: p.name, optional: p.optional, type: w };
      });
      const ret = widenLiterals(node.ret, keep);
      if (ret !== node.ret) changed = true;
      return changed ? { tag: "fn", params, ret } : node;
    }
    case "union": {
      let changed = false;
      const members = node.members.map((m) => {
        const w = widenLiterals(m, keep);
        if (w !== m) changed = true;
        return w;
      });
      return changed ? { tag: "union", members } : node;
    }
    case "prim":
    case "raw":
      return node;
  }
}

/**
 * Serialize a node as if it were a member of an outer `A | B` union —
 * fn types get wrapped in parens to keep precedence unambiguous.
 *
 * External callers (e.g. `apply-types.ts`'s `irDedupUnion`) build their
 * own string-level unions by joining with `|`. They need the same
 * paren-wrapping the in-IR union serializer does. Without this helper
 * they'd default to `serializeType` (top context, no wrap) and
 * reintroduce the precedence bug fixed inside the
 * IR. see the issue
 */
export function serializeTypeAsUnionMember(node: TypeNode): string {
  return serializeInContext(node, "union-member");
}

/**
 * Internal serializer that tracks "what kind of context this node
 * appears in" — `top` is unbracketed; `union-member`, `array-element`,
 * `tuple-element` need parens around bare function types so the `=>`
 * doesn't bleed into the surrounding form.
 *
 * TS exposes the same notion via
 * `TypeFormatFlags.InArrayType` / `InElementType` / `InFirstTypeArgument`
 * — flags the checker uses internally during `typeToString`. Our
 * hand-rolled serializer had no equivalent and produced unparseable
 * strings for cases like `((a: string) => number) | string` (was
 * printed as `(a: string) => number | string`, which TS parses as
 * `(a: string) => (number | string)`).
 */
type SerializeCtx = "top" | "union-member" | "array-element" | "tuple-element" | "type-arg";

function serializeInContext(node: TypeNode, ctx: SerializeCtx): string {
  switch (node.tag) {
    case "prim":
      return node.name;
    case "lit":
      return node.text;
    case "array": {
      const inner = serializeInContext(node.element, "array-element");
      // Wrap union element in `Array<...>` instead of paren-wrapping:
      // `Array<A | B>` is clearer to readers than `(A | B)[]`.
      if (node.element.tag === "union") {
        return `Array<${inner}>`;
      }
      return `${inner}[]`;
    }
    case "tuple":
      return `[${node.elements.map((el) => serializeInContext(el, "tuple-element")).join(", ")}]`;
    case "object": {
      // Match legacy `mergeObjectTypes`: all keys (required + optional)
      // alphabetised together, with `?:` on the optionals. Avoids
      // churning the diff on the apply test suite which asserts the
      // legacy ordering.
      const allKeys = [...node.required.keys(), ...node.optional.keys()].sort();
      const parts: string[] = [];
      for (const k of allKeys) {
        const isOptional = node.optional.has(k);
        const value = isOptional ? node.optional.get(k)! : node.required.get(k)!;
        // Object property values are in a "top" position w.r.t.
        // surrounding syntax — `foo: T` parses unambiguously even when
        // T is a function or union.
        const v = serializeInContext(value, "top");
        if (isOptional) {
          // Method-shape preservation: keys parsed as `name(args)` keep
          // the `name?(args)` form when optional.
          const parenIdx = k.indexOf("(");
          if (parenIdx !== -1) {
            const name = k.slice(0, parenIdx);
            const args = k.slice(parenIdx);
            parts.push(`${name}?${args}: ${v}`);
          } else {
            parts.push(`${k}?: ${v}`);
          }
        } else {
          parts.push(`${k}: ${v}`);
        }
      }
      if (parts.length === 0) return "{}";
      return `{ ${parts.join(", ")} }`;
    }
    case "ref":
      if (node.args.length === 0) return node.name;
      return `${node.name}<${node.args.map((arg) => serializeInContext(arg, "type-arg")).join(", ")}>`;
    case "fn": {
      const inner = `(${node.params
        .map((p) => `${p.name}${p.optional ? "?" : ""}: ${serializeInContext(p.type, "top")}`)
        .join(", ")}) => ${serializeInContext(node.ret, "top")}`;
      // `=>` is greedy in TS — `(...) => T | U` parses as
      // `(...) => (T | U)`. When the fn lands inside a union, array, or
      // tuple position, wrap so the surrounding form doesn't bleed in.
      // (type-arg position is safe because `<T>` brackets delimit it.)
      if (ctx === "union-member" || ctx === "array-element" || ctx === "tuple-element") {
        return `(${inner})`;
      }
      return inner;
    }
    case "union":
      // Spaces around `|` match the legacy `formatTypeSet` format used
      // by the rest of apply (mergeKeyValues, mergeArrayTypes, etc.).
      // Tests across the suite assert against this exact form.
      return [...new Set(node.members.map((m) => serializeInContext(m, "union-member")))]
        .sort()
        .join(" | ");
    case "raw":
      return node.text;
  }
}
