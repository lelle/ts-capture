import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  buildNamedTypeIndex,
  type NamedTypeIndex,
  rewriteToNamedInScope,
} from "./named-type-rewrite.js";

describe("buildNamedTypeIndex — same-file (no Program)", () => {
  it("indexes an interface for exact and subset matching in one value", () => {
    const index = buildNamedTypeIndex("interface Point { x: number; y: number }");
    expect(index.named.get("{ x: number, y: number }")).toBe("Point");
    const subset = index.subset.find((e) => e.name === "Point")!;
    expect([...subset.requiredFields.entries()]).toEqual([
      ["x", "number"],
      ["y", "number"],
    ]);
    expect(subset.optionalFields.size).toBe(0);
  });

  it("partitions optional fields into the subset index", () => {
    const index = buildNamedTypeIndex("interface Config { name: string; debug?: boolean }");
    const subset = index.subset.find((e) => e.name === "Config")!;
    expect([...subset.requiredFields.keys()]).toEqual(["name"]);
    expect([...subset.optionalFields.keys()]).toEqual(["debug"]);
  });

  it("skips generic interfaces and heritage clauses", () => {
    const index = buildNamedTypeIndex(
      "interface Gen<T> { v: T } interface Sub extends Base { id: number }",
    );
    expect([...index.named.values()]).not.toContain("Gen");
    expect([...index.named.values()]).not.toContain("Sub");
    expect(index.subset.map((e) => e.name)).not.toContain("Gen");
    expect(index.subset.map((e) => e.name)).not.toContain("Sub");
  });

  it("indexes a type alias the same as an interface", () => {
    const index = buildNamedTypeIndex("type Bar = { a: number };");
    expect(index.named.get("{ a: number }")).toBe("Bar");
  });
});

// Source-driven rewrite: build the index from source, then rewrite an emitted
// structural type. Migrated from apply-types.spec.ts's "preferNamedInScope
// same-file matching", "subset-match for named-type rewrite", and "subset
// rewrite descends into generic wrappers" blocks.
const rw = (source: string, emitted: string) =>
  rewriteToNamedInScope(emitted, buildNamedTypeIndex(source));

describe("rewriteToNamedInScope — subset matching over a same-file index", () => {
  // A subset match succeeds when every observed field is a (recursively
  // rewritten) field of the named type, all required fields are present, and
  // only optional fields are absent.
  it("rewrites an exact match to a same-file type alias", () => {
    expect(rw("type Bar = { a: number };", "{ a: number }")).toBe("Bar");
  });

  it("matches regardless of source-file key order (canonicalised)", () => {
    expect(rw("interface Foo { z: string, a: number }", "{ a: number, z: string }")).toBe("Foo");
  });

  it("rewrites when an observation omits an optional field", () => {
    const foo =
      "interface Foo {\n  readonly a: number\n  readonly b: string\n  readonly c?: boolean\n}";
    expect(rw(foo, "{ a: number, b: string }")).toBe("Foo");
  });

  it("recursively rewrites a nested structural field before matching the outer", () => {
    const src =
      "interface Inner {\n  readonly k: number\n}\ninterface Outer {\n  readonly name: string\n  readonly inner: Inner\n}";
    expect(rw(src, "{ name: string, inner: { k: number } }")).toBe("Outer");
  });

  it("rewrites the element type of an array of shapes", () => {
    const item = "interface Item {\n  readonly id: number\n  readonly name?: string\n}";
    expect(rw(item, "{ id: number }[]")).toBe("Item[]");
  });

  it("does NOT match when the observation has a field absent from the named type", () => {
    expect(rw("interface Foo {\n  readonly a: number\n}", "{ a: number, x: string }")).toBe(
      "{ a: number, x: string }",
    );
  });

  it("does NOT match when the observation is missing a required field", () => {
    const foo = "interface Foo {\n  readonly a: number\n  readonly required: string\n}";
    expect(rw(foo, "{ a: number }")).toBe("{ a: number }");
  });

  it("does NOT match an extra-field observation against a smaller interface", () => {
    expect(rw("interface Foo { a: number }", "{ a: number, b: string }")).toBe(
      "{ a: number, b: string }",
    );
  });
});

describe("rewriteToNamedInScope — generic-wrapper descent", () => {
  // Name<arg, ...> forms recurse into each type argument; an inner `{ ... }`
  // that subset-matches a named type is rewritten in place.
  const resp = "interface Resp {\n  readonly id: number\n  readonly name: string\n}";
  const item = "interface Item {\n  readonly id: number\n}";

  it("rewrites the inner shape of `Promise<{ ... }>`", () => {
    expect(rw(resp, "Promise<{ id: number, name: string }>")).toBe("Promise<Resp>");
  });

  it("rewrites the inner shape of `Array<{ ... }>`", () => {
    expect(rw(item, "Array<{ id: number }>")).toBe("Array<Item>");
  });

  it("rewrites nested generics `Promise<Array<{ ... }>>`", () => {
    expect(rw(item, "Promise<Array<{ id: number }>>")).toBe("Promise<Array<Item>>");
  });

  it("rewrites each argument of `Map<K, V>` independently", () => {
    const kv = "interface Key {\n  readonly k: string\n}\ninterface Val {\n  readonly v: number\n}";
    expect(rw(kv, "Map<{ k: string }, { v: number }>")).toBe("Map<Key, Val>");
  });

  it("rewrites union members inside a generic argument", () => {
    const ab = "interface A { readonly a: number }\ninterface B { readonly b: string }";
    expect(rw(ab, "Promise<{ a: number } | { b: string }>")).toBe("Promise<A | B>");
  });

  it("leaves the generic unchanged when no inner shape matches", () => {
    expect(rw("let v = 1;", "Promise<{ unique: number }>")).toBe("Promise<{ unique: number }>");
  });
});

describe("rewriteToNamedInScope — pure, over a NamedTypeIndex value", () => {
  const index: NamedTypeIndex = {
    named: new Map([["{ x: number, y: number }", "Point"]]),
    subset: [
      {
        name: "Point",
        requiredFields: new Map([
          ["x", "number"],
          ["y", "number"],
        ]),
        optionalFields: new Map(),
      },
    ],
  };

  it("rewrites an exact canonical match to its name", () => {
    expect(rewriteToNamedInScope("{ x: number, y: number }", index)).toBe("Point");
  });

  it("rewrites via subset match when an observation omits an optional field", () => {
    // Observation ⊆ named type: all required fields present, no extra fields.
    const withOptional: NamedTypeIndex = {
      named: new Map(),
      subset: [
        {
          name: "Config",
          requiredFields: new Map([["name", "string"]]),
          optionalFields: new Map([["debug", "boolean"]]),
        },
      ],
    };
    expect(rewriteToNamedInScope("{ name: string }", withOptional)).toBe("Config");
  });

  it("returns non-object emits unchanged (no `{`)", () => {
    expect(rewriteToNamedInScope("string | number", index)).toBe("string | number");
  });

  it("returns the input unchanged when no index is supplied", () => {
    expect(rewriteToNamedInScope("{ x: number, y: number }", undefined)).toBe(
      "{ x: number, y: number }",
    );
  });

  it("returns the input unchanged when nothing matches", () => {
    expect(rewriteToNamedInScope("{ a: string }", index)).toBe("{ a: string }");
  });
});

describe("buildNamedTypeIndex — cross-file (with Program)", () => {
  // Migrated from apply-types.spec.ts's "preferNamedInScope cross-file" block.
  // With a ts.Program the index follows imports (and re-export barrels) via the
  // TypeChecker to register an imported interface's canonical shape under its
  // imported name. Generic interfaces are skipped; a same-file declaration wins
  // a shape collision; without a Program only same-file decls are indexed.
  function makeProgram(files: Record<string, string>): ts.Program {
    const opts: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
    };
    const host = ts.createCompilerHost(opts);
    const realReadFile = host.readFile.bind(host);
    const realFileExists = host.fileExists.bind(host);
    const realGetSourceFile = host.getSourceFile.bind(host);
    host.readFile = (f) => files[f] ?? realReadFile(f);
    host.fileExists = (f) => f in files || realFileExists(f);
    host.getSourceFile = (f, target) =>
      files[f] !== undefined
        ? ts.createSourceFile(f, files[f], target, true)
        : realGetSourceFile(f, target);
    return ts.createProgram(Object.keys(files), opts, host);
  }

  it("registers an imported interface under its imported name", () => {
    const source =
      "import { BookingState } from './state.js';\nfunction subscribe(s) { return s; }";
    const program = makeProgram({
      "/state.ts": "export interface BookingState { activeCustomer: string; uniqueId: string; }",
      "/test.ts": source,
    });
    expect(
      buildNamedTypeIndex(source, program, "/test.ts").named.get(
        "{ activeCustomer: string, uniqueId: string }",
      ),
    ).toBe("BookingState");
  });

  it("prefers a same-file declaration over an imported one on a shape collision", () => {
    const source = [
      "import { ImportedShape } from './imported.js';",
      "interface LocalShape { a: number; }",
      "function f(x) { return x; }",
    ].join("\n");
    const program = makeProgram({
      "/imported.ts": "export interface ImportedShape { a: number; }",
      "/test.ts": source,
    });
    expect(buildNamedTypeIndex(source, program, "/test.ts").named.get("{ a: number }")).toBe(
      "LocalShape",
    );
  });

  it("skips a generic imported interface", () => {
    const source = "import { Box } from './box.js';\nfunction f(x) { return x; }";
    const program = makeProgram({
      "/box.ts": "export interface Box<T> { value: T; }",
      "/test.ts": source,
    });
    expect(
      buildNamedTypeIndex(source, program, "/test.ts").named.get("{ value: number }"),
    ).toBeUndefined();
  });

  it("resolves a type through a re-export barrel", () => {
    const source = "import { Inner } from './barrel.js';\nfunction f(x) { return x; }";
    const program = makeProgram({
      "/inner.ts": "export interface Inner { id: string; }",
      "/barrel.ts": "export { Inner } from './inner.js';",
      "/test.ts": source,
    });
    expect(buildNamedTypeIndex(source, program, "/test.ts").named.get("{ id: string }")).toBe(
      "Inner",
    );
  });

  it("indexes only same-file declarations when no Program is supplied", () => {
    const source =
      "import { BookingState } from './state.js';\nfunction subscribe(s) { return s; }";
    expect(
      buildNamedTypeIndex(source).named.get("{ activeCustomer: string, uniqueId: string }"),
    ).toBeUndefined();
  });
});
