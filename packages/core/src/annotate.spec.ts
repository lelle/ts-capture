import { describe, expect, it } from "vitest";

import type { CollectedTypeInfo } from "./type-collector.js";

import { annotate, annotateProject, type AnnotateResult, type TypeOracle } from "./annotate.js";
import { createProjectVerificationContext } from "./apply-types-verify.js";
import { checked, entry } from "./test-utils/applied.js";
import { collect } from "./test-utils/collected.js";
import { makeProject, programOf } from "./test-utils/project.js";

// The boundary of the applier: text and observations in, text, skips and
// telemetry out. Every case runs on each oracle tier, since what the module
// can check is the only thing the tier is allowed to change.

type Tier = TypeOracle["kind"];
const TIERS: Tier[] = ["none", "program", "project"];

/** Annotate `source` as `target.ts` of a fresh project, with the tier's oracle. */
function annotated(tier: Tier, source: string, entries: CollectedTypeInfo) {
  const project = makeProject({ "target.ts": source });
  const filename = project.pathOf("target.ts");
  const oracle: TypeOracle =
    tier === "none"
      ? { kind: "none" }
      : tier === "program"
        ? { kind: "program", program: programOf(project) }
        : {
            kind: "project",
            project: createProjectVerificationContext(
              project.fileNames,
              project.compilerOptions,
              project.dir,
            ),
          };
  const result = annotate(source, entries, { filename, oracle });
  return { result, out: checked(source, result.text) };
}

const written = (result: AnnotateResult, source: string) => result.text !== source;
const skippedAt = (result: AnnotateResult, pos: number) =>
  result.skips.some((skip) => skip.pos === pos);

describe.each(TIERS)("annotate, oracle %s", (tier) => {
  it("types a parameter", () => {
    const source = "function f(a) { return a; }\nf(1);\n";
    const { out } = annotated(tier, source, collect(source));
    expect(out).toAnnotate("a", "number");
    expect(out).toHaveNoNewDiagnostics();
  });

  it("types a return TypeScript cannot infer", () => {
    const source = "function f(a: string) { return JSON.parse(a); }\nf('{\"n\":1}');\n";
    const { out } = annotated(tier, source, collect(source));
    expect(out).toAnnotate({ returnOf: "f" }, "{ n: number }");
  });

  it("types a variable TypeScript cannot infer", () => {
    const source = "const data = JSON.parse('{\"n\":1}');\n";
    const { out } = annotated(tier, source, collect(source));
    expect(out).toAnnotate("data", "{ n: number }");
  });

  it("types a class field from the constructor parameter assigned to it", () => {
    const source =
      "class Counter {\n  count;\n  constructor(initial) { this.count = initial; }\n}\nnew Counter(1);\n";
    const { out } = annotated(tier, source, collect(source));
    // Under `project`, TypeScript infers the field from the typed parameter.
    expect(out).toTypeAs("count", "number");
    expect(out).toAnnotate("initial", "number");
  });

  // The field's entry is made by apply, not observed, so nothing else would
  // say why a field was left untyped.
  it("says why it left a class field untyped", () => {
    const source =
      "class Box {\n  item;\n  constructor(item) { this.item = item; }\n}\nnew Box(undefined);\n";
    const { result } = annotated(tier, source, [
      entry("target.ts", source.indexOf("item)") + 4, [["unknown"]]),
    ]);
    expect(result.skips).toContainEqual(
      expect.objectContaining({ pos: source.indexOf("item;") + 4 }),
    );
  });

  // Under `project` the outer function is typed first, and the callback then
  // takes its parameter's type from it instead of an annotation of its own.
  it("types the parameter of a callback", () => {
    const source = "function each(xs, cb) { for (const x of xs) cb(x); }\neach([1], (n) => n);\n";
    const { out } = annotated(tier, source, collect(source));
    expect(out).toTypeAs("n", "number");
  });

  // CST counts it as idempotent but records no skip. Red until step 2.
  it.fails("leaves a written type alone and says why", () => {
    const source = "function f(a: number) { return a; }\n";
    const pos = source.indexOf("a:") + 1;
    const { result } = annotated(tier, source, [entry("target.ts", pos, [["string"]])]);
    expect(result.text).toBe(source);
    expect(result.skips).toContainEqual(expect.objectContaining({ pos }));
  });

  it("reports a skip at its position in the text it was given", () => {
    const source = "const n = 1;\n";
    const pos = source.indexOf("n =") + 1;
    const { result } = annotated(tier, source, [
      entry("target.ts", pos, [["number"]], { varDecl: true }),
    ]);
    expect(result.text).toBe(source);
    expect(result.skips).toContainEqual(expect.objectContaining({ pos, reason: "redundant" }));
  });

  it("returns its telemetry instead of filling one passed in", () => {
    const source = "function f(a) { return a; }\nf(1);\n";
    const { result } = annotated(tier, source, collect(source));
    expect(result.telemetry.emitted).toBeGreaterThan(0);
    expect(result.telemetry.skipped).toEqual(result.skips);
  });

  it("writes nothing to a file matched by ignoreFiles", () => {
    const source = "function f(a) { return a; }\nf(1);\n";
    const result = annotate(source, collect(source), {
      filename: "/src/generated/f.ts",
      ignoreFiles: [/generated/],
    });
    expect(result.text).toBe(source);
  });

  // Each entry is either written or skipped with a reason; none leaves
  // silently. Entries the CST index cannot place go to the offset applier,
  // which records no skips, so these stay red until step 2 of the RFC.
  describe("every entry is written or skipped", () => {
    it("for entries at a site", () => {
      const source = "function f(a, b: string) { return a; }\nf(1, 'x');\nconst n = 1;\n";
      for (const e of [
        ...collect(source),
        entry("target.ts", source.indexOf("n =") + 1, [["number"]], { varDecl: true }),
      ]) {
        const { result } = annotated(tier, source, [e]);
        expect(written(result, source) || skippedAt(result, e[1]), `entry at ${e[1]}`).toBe(true);
      }
    });

    it.fails("for an entry at no site", () => {
      const source = "function f(a) { return a; }\n";
      const { result } = annotated(tier, source, [entry("target.ts", 99, [["string"]])]);
      expect(result.text).toBe(source);
      expect(skippedAt(result, 99)).toBe(true);
    });
  });
});

// What a tier with more to check writes is what a tier with less writes,
// minus what the checker rejects with a reason.
describe("a tier with more to check writes no more than one with less, or says why", () => {
  const CORPUS = [
    "function f(a) { return a; }\nf(1);\n",
    "function g(a) { return [a]; }\ng('x');\n",
    "const data = JSON.parse('{\"n\":1}');\n",
    "class C {\n  v;\n  constructor(v) { this.v = v; }\n  get() { return this.v; }\n}\nnew C(true).get();\n",
    "function each(xs, cb) { for (const x of xs) cb(x); }\neach([1], (n) => n * 2);\n",
    "function h() { return undefined; }\nh();\n",
  ];

  it.each(CORPUS)("%s", (source) => {
    for (const e of collect(source)) {
      const none = annotated("none", source, [e]).result;
      const program = annotated("program", source, [e]).result;
      const project = annotated("project", source, [e]).result;
      if (written(none, source)) {
        expect(written(program, source) || skippedAt(program, e[1]), `program at ${e[1]}`).toBe(
          true,
        );
      }
      if (written(program, source)) {
        expect(written(project, source) || skippedAt(project, e[1]), `project at ${e[1]}`).toBe(
          true,
        );
      }
    }
  });
});

describe("annotateProject", () => {
  function projectOf(files: Record<string, string>) {
    const project = makeProject(files);
    const context = createProjectVerificationContext(
      project.fileNames,
      project.compilerOptions,
      project.dir,
    );
    return { project, context };
  }

  it("annotates every observed file and keeps each skip relative to its own file", () => {
    const a = "export function f(a) { return a; }\n";
    const b = "export const n = 1;\n";
    const { project } = projectOf({ "a.ts": a, "b.ts": b });
    const aPath = project.pathOf("a.ts");
    const bPath = project.pathOf("b.ts");
    const nPos = b.indexOf("n =") + 1;
    const run = annotateProject({
      types: [
        entry(aPath, a.indexOf("a)") + 1, [["number"]]),
        entry(bPath, nPos, [["number"]], { varDecl: true }),
      ],
      readFile: (path) => project.read(path.slice(project.dir.length + 1)),
    });
    expect(checked(a, run.files.get(aPath)!.text, { filename: "a.ts" })).toAnnotate("a", "number");
    expect(run.files.get(bPath)!.skips).toContainEqual(
      expect.objectContaining({ pos: nPos, reason: "redundant", file: bPath }),
    );
    expect(run.telemetry.emitted).toBe(1);
    expect(run.telemetry.skipped).toHaveLength(1);
  });

  it("checks a file against the annotations it imports, under the project oracle", () => {
    // `use` reads `make`'s result. With `make` typed first, the local `m`
    // infers its type and needs no annotation of its own.
    const lib = "export function make(n) { return { n }; }\n";
    const use = 'import { make } from "./lib";\nexport const m = make(1);\n';
    const { project, context } = projectOf({ "lib.ts": lib, "use.ts": use });
    const libPath = project.pathOf("lib.ts");
    const usePath = project.pathOf("use.ts");
    const run = annotateProject({
      // The importer is listed first, so the order has to come from the imports.
      types: [
        entry(usePath, use.indexOf("m =") + 1, [["{ n: number }"]], { varDecl: true }),
        entry(libPath, lib.indexOf("n)") + 1, [["number"]]),
        entry(libPath, lib.indexOf(") {") + 1, [["{ n: number }"]], { returnType: true }),
      ],
      readFile: (path) => project.read(path.slice(project.dir.length + 1)),
      oracle: { kind: "project", project: context },
    });
    expect(run.files.get(usePath)!.text).toBe(use);
    expect(run.files.get(usePath)!.skips).toContainEqual(
      expect.objectContaining({ reason: "redundant" }),
    );
  });

  it("skips a file it cannot read", () => {
    const run = annotateProject({
      types: [entry("/nowhere.ts", 1, [["number"]])],
      readFile: () => undefined,
    });
    expect(run.files.size).toBe(0);
  });
});
