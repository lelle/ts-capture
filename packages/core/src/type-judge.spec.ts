import { describe, expect, it } from "vitest";

import type { TypeOracle } from "./annotate.js";
import type { CollectedTypeInfo, ExtraOptions } from "./type-collector.js";

import { makeProject, programOf } from "./test-utils/project.js";
import { type Fit, typeJudge } from "./type-judge.js";

// The judge reads what the run saw against the type TypeScript has at the
// position. Each case is one rule of how the runtime writes types, found on
// hono and nest (rfc-type-judge, "The observed dialect").

type Tier = TypeOracle["kind"];

/** Judge the observations at the end of `marker` in `target` (at its `)` for a return). */
function judged(
  files: Record<string, string>,
  marker: string,
  observed: string[],
  opts: ExtraOptions = {},
  tier: Tier = "program",
): Fit {
  const project = makeProject(files);
  const target = Object.keys(files)[0]!;
  const source = files[target]!;
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} in ${target}`);
  const pos = opts.returnType ? source.indexOf(")", at) + 1 : at + marker.length;
  const entry: CollectedTypeInfo[number] = [
    project.pathOf(target),
    pos,
    observed.map((o) => [o, undefined]),
    { annotated: true, ...opts },
  ];
  const oracle: TypeOracle =
    tier === "none" ? { kind: "none" } : { kind: "program", program: programOf(project) };
  return typeJudge(oracle, [entry]).fits(entry);
}

const one = (source: string): Record<string, string> => ({ "a.ts": source });

describe("typeJudge.fits", () => {
  describe("named and complex declared types, which text cannot answer", () => {
    const user = "interface User { id: number; name: string }\n";

    it("matches a shape that holds the interface", () => {
      expect(
        judged(one(`${user}export function f(u: User) { return u; }\n`), "(u", [
          "{ id: number, name: string, extra: boolean }",
        ]),
      ).toMatchObject({ verdict: "match", declared: "User" });
    });

    it("says which arm the interface cannot hold", () => {
      expect(
        judged(one(`${user}export function f(u: User) { return u; }\n`), "(u", [
          "{ id: number, name: string }",
          "{ id: string, name: string }",
        ]),
      ).toMatchObject({ verdict: "mismatch", outside: ["{ id: string, name: string }"] });
    });

    it("leaves them unverifiable without a checker, as today", () => {
      expect(
        judged(
          one(`${user}export function f(u: User) { return u; }\n`),
          "(u",
          ["{ id: number, name: string }"],
          {},
          "none",
        ),
      ).toMatchObject({ verdict: "unverifiable" });
    });
  });

  describe("names the file cannot see", () => {
    const fn = "export function f(p: { kind: string }) { return p; }\n";

    it("imports a class exported by exactly one module", () => {
      expect(
        judged({ "a.ts": fn, "cat.ts": "export class Cat { kind = 'cat'; }\n" }, "(p", ["Cat"]),
      ).toMatchObject({ verdict: "match" });
    });

    it("imports a class observed as itself, `typeof Cat`", () => {
      expect(
        judged(
          {
            "a.ts": "export function f(c: new () => { kind: string }) { return c; }\n",
            "cat.ts": "export class Cat { kind = 'cat'; }\n",
          },
          "(c",
          ["typeof Cat"],
        ),
      ).toMatchObject({ verdict: "match" });
    });

    it("does not guess between two exports of one name", () => {
      expect(
        judged(
          {
            "a.ts": fn,
            "one.ts": "export class Cat { kind = 'one'; }\n",
            "two.ts": "export class Cat { kind = 'two'; }\n",
          },
          "(p",
          ["Cat"],
        ),
      ).toMatchObject({ verdict: "unverifiable", reason: "ambiguous name" });
    });

    it("says when no module exports it", () => {
      expect(judged(one(fn), "(p", ["Cat"])).toMatchObject({
        verdict: "unverifiable",
        reason: "name not in scope",
      });
    });
  });

  describe("how the runtime writes what it saw", () => {
    it("reads `unknown` as nothing observed", () => {
      expect(
        judged(one("export function f(m: Map<string, number>) { return m; }\n"), "(m", [
          "Map<unknown, unknown>",
        ]),
      ).toMatchObject({ verdict: "match" });
    });

    it("knows of an observed function only that it can be called", () => {
      expect(
        judged(one("export function f(cb: (e: Error) => void) { return cb; }\n"), "(cb", [
          "(e: unknown, extra: unknown) => Promise<unknown>",
        ]),
      ).toMatchObject({ verdict: "match" });
    });

    it("cannot tell a function returning an array from an array of functions", () => {
      expect(
        judged(one("type H = () => void;\nexport function f(hs: H[]) { return hs; }\n"), "(hs", [
          "(c: unknown) => unknown[]",
        ]),
      ).toMatchObject({ verdict: "unverifiable", reason: "function or array of functions" });
    });

    it("gives a generic observed without arguments `any` arguments", () => {
      expect(
        judged(one("export function f(m: Map<string, number>) { return m; }\n"), "(m", ["Map"]),
      ).toMatchObject({ verdict: "match" });
    });

    // The runtime cannot tell a tuple from an array; an element no position
    // holds still refutes it.
    it("finds an array element no position of a tuple holds", () => {
      expect(
        judged(one("export function f(t: [number, string]) { return t; }\n"), "(t", [
          "Array<number | boolean>",
        ]),
      ).toMatchObject({ verdict: "mismatch" });
    });
  });

  describe("what an observation cannot refute", () => {
    it("a declared type narrower than any observation can be: a brand", () => {
      expect(
        judged(
          one("type Id = string & { __brand: 'id' };\nexport function f(id: Id) { return id; }\n"),
          "(id",
          ["string"],
        ),
      ).toMatchObject({ verdict: "unverifiable", reason: "declared narrower than observable" });
    });

    it("a literal type, which the run widens, at any depth", () => {
      expect(
        judged(
          one("type K = { kind: 'a' | 'b' };\nexport function f(o: K) { return o; }\n"),
          "(o",
          ["{ kind: string }"],
        ),
      ).toMatchObject({ verdict: "unverifiable", reason: "literal declared type" });
    });

    it("a type parameter", () => {
      expect(
        judged(one("export function f<T>(x: T) { return x; }\n"), "(x", ["string"]),
      ).toMatchObject({ verdict: "unverifiable", reason: "generic declared type" });
    });

    it("a type parameter deep inside a tuple", () => {
      expect(
        judged(one("export function f<T>(x: [T, number][]) { return x; }\n"), "(x", [
          "Array<[string, number, boolean]>",
        ]),
      ).toMatchObject({ verdict: "unverifiable", reason: "generic declared type" });
    });

    it("a conditional type", () => {
      expect(
        judged(
          one("export function f<T>(x: T extends string ? number : boolean) { return x; }\n"),
          "(x",
          ["string"],
        ),
      ).toMatchObject({ verdict: "unverifiable", reason: "generic declared type" });
    });

    it("a property the runtime does not record: a symbol key, an inherited method", () => {
      expect(
        judged(
          one(
            "const S = Symbol();\nclass Node { label = ''; [S] = 1; size() { return 1; } }\n" +
              "export function f(n: Node) { return n; }\n",
          ),
          "(n",
          ["{ label: string }"],
        ),
      ).toMatchObject({ verdict: "unverifiable", reason: "properties not observed" });
    });
  });

  describe("what an observation does refute", () => {
    it("a boxed String where a string is declared", () => {
      expect(
        judged(one("export function f(s: string) { return s; }\n"), "(s", ["String"]),
      ).toMatchObject({ verdict: "mismatch", outside: ["String"] });
    });

    // A named class is known by its declaration; only a shape the runtime
    // walked can lack what it did not record.
    it("a named class that lacks a member the type requires", () => {
      expect(
        judged(one("export function f(s: Set<string>) { return s; }\n"), "(s", [
          "Map<string, number>",
        ]),
      ).toMatchObject({ verdict: "mismatch" });
    });

    it("a value outside a type parameter's constraint", () => {
      expect(
        judged(one("export function f<T extends string>(x: T) { return x; }\n"), "(x", ["number"]),
      ).toMatchObject({ verdict: "mismatch" });
    });

    it("a missing key the type does not let be undefined", () => {
      expect(
        judged(one("export function f(o: { a: string; b: number }) { return o; }\n"), "(o", [
          "{ a: string }",
        ]),
      ).toMatchObject({ verdict: "mismatch" });
    });

    it("but not a missing key the type lets be undefined", () => {
      expect(
        judged(
          one("export function f(o: { a: string; b: number | undefined }) { return o; }\n"),
          "(o",
          ["{ a: string }"],
        ),
      ).toMatchObject({ verdict: "match" });
    });
  });

  // TypeScript loads a package installed twice once, and points the second
  // copy at the first.
  it("judges in a program that holds one package twice", () => {
    const dup = {
      "package.json": JSON.stringify({ name: "dup", version: "1.0.0", types: "index.d.ts" }),
      "index.d.ts": "export interface Box { v: number }\n",
    };
    const files: Record<string, string> = {
      "a.ts":
        'import { take } from "left";\nimport { give } from "right";\n' +
        "interface User { id: number }\nexport function f(u: User) { return [take, give, u]; }\n",
      "node_modules/left/package.json": JSON.stringify({ name: "left", types: "index.d.ts" }),
      "node_modules/left/index.d.ts":
        'import type { Box } from "dup";\nexport declare function take(b: Box): void;\n',
      "node_modules/right/package.json": JSON.stringify({ name: "right", types: "index.d.ts" }),
      "node_modules/right/index.d.ts":
        'import type { Box } from "dup";\nexport declare function give(): Box;\n',
    };
    for (const [name, text] of Object.entries(dup)) {
      files[`node_modules/left/node_modules/dup/${name}`] = text;
      files[`node_modules/right/node_modules/dup/${name}`] = text;
    }
    expect(judged(files, "(u", ["{ id: number }"])).toMatchObject({ verdict: "match" });
  });

  it("keeps a match the text already found, though the checker cannot resolve it", () => {
    // `Widget` is local to `g`: the end of the file cannot see it.
    expect(
      judged(
        one("export function g() {\n  class Widget {}\n  return (w: Widget) => w;\n}\n"),
        "(w",
        ["Widget"],
      ),
    ).toMatchObject({ verdict: "match" });
  });

  it("says where and what the declaration is", () => {
    expect(
      judged(one("export function f(count: number) { return count; }\n"), "(count", ["number"]),
    ).toMatchObject({ verdict: "match", declared: "number", name: "count", line: 1, column: 19 });
  });

  it("has no declaration at a position no declaration ends at", () => {
    expect(judged(one("export const x = 1;\n"), "export", ["number"])).toMatchObject({
      verdict: "no-declaration",
    });
  });
});
