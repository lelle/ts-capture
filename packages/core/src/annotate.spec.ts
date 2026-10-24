import { describe, expect, it } from "vitest";

import type { InferOptions } from "./configuration.js";
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

/** Annotate `source` as `file` of a fresh project, with the tier's oracle. */
function annotated(
  tier: Tier,
  source: string,
  entries: CollectedTypeInfo,
  file = "target.ts",
  infer?: Partial<InferOptions>,
) {
  const project = makeProject({ [file]: source });
  const filename = project.pathOf(file);
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
  const result = annotate(source, entries, { filename, oracle, infer });
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

  // The parameter's own entry may be skipped, or missing, before it asks for
  // the parens; `s: number => …` does not parse.
  it("wraps a paren-less arrow's parameter when only its return is written", () => {
    const source = "const parse = s => JSON.parse(s);\nparse('1');\n";
    const pos = source.indexOf("s =>") + 1;
    const { result, out } = annotated(tier, source, [
      entry("target.ts", pos, [["number"]], { returnType: true }),
    ]);
    expect(out).toHaveNoNewDiagnostics();
    // Under `project` the probe lacks the parens, so the candidate is rejected.
    if (tier !== "project") {
      expect(result.text).toContain("const parse = (s): number => JSON.parse(s);");
    }
  });

  // Read as plain TypeScript, the JSX before it turns the arrow into error
  // recovery nodes, and its entries find no site.
  it("types an arrow inside JSX in a .tsx file", () => {
    const source = [
      "it('no error', async () => {",
      "  const App = () => {",
      "    const [count, setCount] = useState(0)",
      "    return (",
      "      <Suspense fallback={<div>Loading...</div>}>",
      "        <div>",
      "          <button",
      "            onClick={() => {",
      "              startTransition(() => {",
      "                setCount((c) => c + 1)",
      "              })",
      "            }}",
      "          >",
      "            {count}",
      "          </button>",
      "        </div>",
      "      </Suspense>",
      "    )",
      "  }",
      "  render(<App />, root)",
      "})",
      "",
    ].join("\n");
    const pos = source.indexOf("(c)") + 2;
    const { result } = annotated(
      tier,
      source,
      [entry("App.tsx", pos, [["number"]], { arrow: true })],
      "App.tsx",
    );
    expect(result.skips.map((skip) => skip.reason)).not.toContain("no-site");
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

  describe("leaves a written type alone and says why", () => {
    const source = "function f(a: number): number { return a; }\nconst n: number = f(1);\n";
    it.each([
      ["a parameter", source.indexOf("a:") + 1, {}],
      ["a return", source.indexOf("): number") + 1, { returnType: true }],
      ["a variable", source.indexOf("n:") + 1, { varDecl: true }],
    ])("%s", (_, pos, opts) => {
      const { result } = annotated(tier, source, [entry("target.ts", pos, [["string"]], opts)]);
      expect(result.text).toBe(source);
      expect(result.skips).toContainEqual(
        expect.objectContaining({ pos, reason: "already-annotated", observed: "string" }),
      );
    });

    it("a `this`", () => {
      const typed = "function greet(this: Date) { return this.getTime(); }\n";
      const pos = typed.indexOf("(") + 1;
      const { result } = annotated(tier, typed, [
        entry("target.ts", pos, [["Date"]], { thisType: true }),
      ]);
      expect(result.text).toBe(typed);
      expect(result.skips).toContainEqual(
        expect.objectContaining({ pos, reason: "already-annotated" }),
      );
    });
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

  it("says it left a declaration marked @ts-capture-ignore alone", () => {
    const source = "// @ts-capture-ignore\nfunction f(a) { return a; }\n";
    const pos = source.indexOf("a)") + 1;
    const { result } = annotated(tier, source, [entry("target.ts", pos, [["number"]])]);
    expect(result.text).toBe(source);
    expect(result.skips).toEqual([
      { pos, reason: "ignored", rule: "syntax.ignored", observed: "number" },
    ]);
  });

  // Parallel workers record the same site many times, one observation each.
  // A parameter no call passed was observed as `undefined` alone. Written, it
  // would turn every later call that passes something into a type error.
  describe("leaves a parameter no call passed", () => {
    it("on a function", () => {
      const source = "export function connect(options) {\n  return options;\n}\n";
      const pos = source.indexOf("options)") + "options".length;
      const { result } = annotated(tier, source, [entry("target.ts", pos, [["undefined"]])]);
      expect(result.text).toBe(source);
      expect(result.skips).toContainEqual(
        expect.objectContaining({
          pos,
          reason: "no-information",
          detail: "every call left it out",
        }),
      );
    });

    it("but writes one that was sometimes passed", () => {
      const source = "export function connect(options) {\n  return options;\n}\n";
      const pos = source.indexOf("options)") + "options".length;
      const { result } = annotated(tier, source, [
        entry("target.ts", pos, [["undefined"], ["{ retries: number }"]]),
      ]);
      expect(result.text).toContain("options: { retries: number } | undefined");
    });
  });

  describe("judges a site by all its entries together", () => {
    const source = "declare const a: string | undefined;\nconst p = a ?? 1;\n";
    const pos = source.indexOf("p =") + 1;

    it("records one skip for a site seen many times", () => {
      const e = () => entry("target.ts", pos, [["string"]], { varDecl: true });
      const { result } = annotated(tier, source, [e(), e(), e()]);
      expect(result.skips.filter((skip) => skip.pos === pos)).toHaveLength(1);
    });

    it("counts both branches seen in separate entries", () => {
      const { result } = annotated(tier, source, [
        entry("target.ts", pos, [["string"]], { varDecl: true }),
        entry("target.ts", pos, [["number"]], { varDecl: true }),
      ]);
      expect(result.skips).not.toContainEqual(
        expect.objectContaining({ detail: "one branch of the initializer observed" }),
      );
    });
  });

  // TypeScript types `next` from where the callback is assigned; the run
  // passed `undefined` too. A function arm in the union must not hide that.
  it("reports a callback the run passed undefined where TypeScript says a function", () => {
    if (tier === "none") return;
    const source = "export const step: (next: () => void) => void = (next) => next?.();\n";
    const pos = source.indexOf("(next)") + "(next".length;
    const { result } = annotated(tier, source, [
      entry("target.ts", pos, [["() => void"], ["undefined"]]),
    ]);
    expect(result.skips).toContainEqual(expect.objectContaining({ pos, reason: "contradiction" }));
  });

  describe("says why it left a variable to TypeScript", () => {
    it.each([
      [
        "whose initializer is a function",
        "const g = (x: number) => x;\n",
        "g =",
        ["(x: number) => number"],
        "kept-existing",
      ],
      [
        "whose initializer passes type arguments",
        "declare function make<T>(): T;\nconst m = make<string>();\n",
        "m =",
        ["string"],
        "kept-existing",
      ],
      [
        "inside a generic function",
        "function id<T>(v: T) { const w = v; return w; }\n",
        "w =",
        ["number"],
        "kept-existing",
      ],
      [
        "whose initializer chooses between functions",
        "declare const asc: boolean;\nconst c = asc ? (a: number) => a : (a: number) => -a;\n",
        "c =",
        ["(a: number) => number", "(a: unknown) => unknown"],
        "kept-existing",
      ],
      [
        "seen at one branch of a union",
        "declare const a: string | undefined;\nconst p = a ?? 1;\n",
        "p =",
        ["string"],
        "left-to-typescript",
      ],
      [
        "seen only as undefined",
        "declare function get(): string | undefined;\nconst u = get();\n",
        "u =",
        ["undefined"],
        "left-to-typescript",
      ],
    ])("%s", (_, source, at, types, reason) => {
      const pos = source.indexOf(at) + 1;
      const { result } = annotated(tier, source, [
        entry(
          "target.ts",
          pos,
          types.map((t) => [t]),
          { varDecl: true },
        ),
      ]);
      expect(result.text).toBe(source);
      expect(result.skips).toEqual([
        expect.objectContaining({ pos, reason, detail: expect.any(String) }),
      ]);
    });
  });

  // `apply --infer.outputMode=comments` writes a line's one note above it, and
  // the apply that follows reads the same observations, made before the note.
  it("places an entry collected before a preview wrote its notes", () => {
    const pristine = "const k = 1;\nfunction f(a) { return a; }\n";
    const entries = [entry("target.ts", pristine.indexOf("a)") + 1, [["number"]])];
    const preview = annotate(pristine, entries, { infer: { outputMode: "comments" } }).text;
    expect(preview).toContain("@ts-capture[proposal]");
    const { result } = annotated(tier, preview, entries);
    expect(checked(pristine, result.text)).toAnnotate("a", "number");
    expect(result.text).not.toContain("@ts-capture");
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
  // silently.
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

    it.each([
      ["a parameter", {}],
      ["a return", { returnType: true }],
      ["a variable", { varDecl: true }],
      ["a this", { thisType: true }],
    ])("for %s entry at no site", (_, opts) => {
      const source = "function f(a) { return a; }\n";
      const pos = source.indexOf("return");
      const { result } = annotated(tier, source, [entry("target.ts", pos, [["string"]], opts)]);
      expect(result.text).toBe(source);
      expect(result.skips).toEqual([
        { pos, reason: "no-site", rule: "syntax.no-site", observed: "string" },
      ]);
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
      const byTier: Array<[Tier, AnnotateResult]> = [
        ["none", none],
        ["program", program],
        ["project", project],
      ];
      for (const [tier, result] of byTier) {
        expect(
          written(result, source) || skippedAt(result, e[1]),
          `${tier} leaves ${e[1]} silently`,
        ).toBe(true);
      }
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

// TypeScript infers the binding from the return type written in the same run,
// and that is wider than what this one call returned.
describe("annotate, a binding narrower than its initializer's type", () => {
  it("leaves the binding to TypeScript instead of reporting a type error", () => {
    const source =
      "function valuesOrNull(...values) { return values; }\n" +
      "valuesOrNull(1, 2);\n" +
      "valuesOrNull('1', 2);\n" +
      "const fromNull = valuesOrNull(null);\n";
    const { result, out } = annotated("project", source, collect(source));
    expect(out).toAnnotate("values", "(number | string | null)[]");
    expect(out).toLeaveUntyped("fromNull");
    expect(result.skips).toContainEqual(
      expect.objectContaining({
        pos: source.indexOf("fromNull =") + "fromNull".length,
        reason: "left-to-typescript",
      }),
    );
    expect(result.skips.filter((skip) => skip.reason === "type-error")).toEqual([]);
  });

  it("leaves a binding seen at one arm of a declared union to TypeScript", () => {
    const source = "declare function get(): string | undefined;\nconst u = get();\n";
    const pos = source.indexOf("u =") + 1;
    const { result } = annotated("project", source, [
      entry("target.ts", pos, [["string"]], { varDecl: true }),
    ]);
    expect(result.text).toBe(source);
    expect(result.skips).toEqual([expect.objectContaining({ pos, reason: "left-to-typescript" })]);
  });

  it("leaves a binding missing a payload arm of the inferred union to TypeScript", () => {
    const source = "declare function find(): { id: number } | null;\nconst found = find();\n";
    const pos = source.indexOf("found =") + "found".length;
    const { result } = annotated("project", source, [
      entry("target.ts", pos, [["null"]], { varDecl: true }),
    ]);
    expect(result.text).toBe(source);
    expect(result.skips).toEqual([
      expect.objectContaining({
        pos,
        reason: "left-to-typescript",
        rule: "gate.discards-union-arm",
      }),
    ]);
  });

  it("still reports a binding outside the initializer's type as a type error", () => {
    const source = "declare function get(): string | undefined;\nconst u = get();\n";
    const pos = source.indexOf("u =") + 1;
    const { result } = annotated("project", source, [
      entry("target.ts", pos, [["number"]], { varDecl: true }),
    ]);
    expect(result.text).toBe(source);
    expect(result.skips).toEqual([expect.objectContaining({ pos, reason: "type-error" })]);
  });
});

// The parameter written in the same run decides what TypeScript infers for the
// return, which before the run was `any[]`.
describe("annotate, a return type judged with the parameters written", () => {
  it("writes what TypeScript infers where the run saw a narrower return", () => {
    const source =
      "function valuesOrNull(...values) {\n" +
      "  if (!values[0]) { return null; }\n" +
      "  return values;\n" +
      "}\n" +
      "valuesOrNull(1, 2);\n" +
      "valuesOrNull('1', 2);\n" +
      "valuesOrNull(null);\n";
    const { result, out } = annotated("project", source, collect(source));
    expect(out).toAnnotate("values", "(number | string | null)[]");
    expect(out).toAnnotate({ returnOf: "valuesOrNull" }, "(number | string | null)[] | null");
    expect(out).toHaveNoNewDiagnostics();
    expect(result.skips.filter((skip) => skip.pos === source.indexOf(") {") + 1)).toEqual([]);
  });

  it("spells TypeScript's type the way apply spells its own", () => {
    const source =
      "function valuesOrNull(...values) {\n" +
      "  if (!values[0]) { return null; }\n" +
      "  return values;\n" +
      "}\n" +
      "valuesOrNull(1, 2);\n" +
      "valuesOrNull('1', 2);\n";
    const { result } = annotated("project", source, collect(source));
    expect(result.text).toContain(
      "function valuesOrNull(...values: (number | string)[]): (number | string)[] | null {",
    );
  });

  // Before the run TypeScript already inferred this return; writing it is a
  // restatement, made only when restatements are asked for.
  const known =
    "function findUser(id: number) {\n" +
    "  if (id < 0) return null;\n" +
    "  return { id };\n" +
    "}\n" +
    "findUser(1);\n";

  it("leaves a return TypeScript inferred before the run to TypeScript", () => {
    const { result } = annotated("project", known, collect(known));
    expect(result.text).toBe(known);
    expect(result.skips).toContainEqual(
      expect.objectContaining({ reason: "left-to-typescript", rule: "verify.wider-after-run" }),
    );
  });

  // Before the run TypeScript writes a generic with defaults out in full
  // (`Call<any>`), and by its name alone where the return is judged; both are
  // the type it already had.
  it("leaves a known return to TypeScript however TypeScript spells a generic's defaults", () => {
    const source =
      "interface Call<TRequest = any> { request: TRequest }\n" +
      "class Server {\n" +
      "  handlerFor(prefix: string) {\n" +
      "    return async (call: Call, done: (error: unknown) => void) => {\n" +
      "      if (!call) return done(null);\n" +
      "      done(prefix);\n" +
      "    };\n" +
      "  }\n" +
      "}\n";
    const pos = source.indexOf(") {") + 1;
    const observed = "(call: Call, done: (error: unknown) => void) => Promise<undefined>";
    const { result } = annotated("project", source, [
      entry("target.ts", pos, [[observed]], { returnType: true }),
    ]);
    expect(result.text).toBe(source);
    expect(result.skips).toContainEqual(
      expect.objectContaining({
        pos,
        reason: "left-to-typescript",
        rule: "verify.wider-after-run",
      }),
    );
  });

  it("restates it when redundant annotations are asked for", () => {
    const { result } = annotated("project", known, collect(known), "target.ts", {
      skipRedundantAnnotations: false,
    });
    expect(result.text).toContain("function findUser(id: number): { id: number } | null {");
  });
});

// A Svelte block is checked as a file of its own, next to the component, that
// the project's tsconfig never listed.
describe("annotate, a file the project does not hold, under the project oracle", () => {
  it("checks it against the project as if it were one of its files", () => {
    const project = makeProject({ "lib.ts": "export const unit = 2;\n" });
    const oracle: TypeOracle = {
      kind: "project",
      project: createProjectVerificationContext(
        project.fileNames,
        project.compilerOptions,
        project.dir,
      ),
    };
    const source =
      'import { unit } from "./lib";\n' +
      "export function scale(n) { return n * unit; }\n" +
      "export function shout(s) { return s.toUpperCase(); }\n";
    const nPos = source.indexOf("n)") + 1;
    const sPos = source.indexOf("s)") + 1;
    const result = annotate(
      source,
      [
        entry("Box.svelte__script.ts", nPos, [["number"]]),
        entry("Box.svelte__script.ts", sPos, [["number"]]),
      ],
      {
        filename: project.pathOf("Box.svelte__script.ts"),
        oracle,
      },
    );
    expect(result.text).toContain("scale(n: number)");
    expect(result.skips).toContainEqual(
      expect.objectContaining({ pos: sPos, reason: "type-error" }),
    );
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

  it("checks a file the project does not hold against it, under the project oracle", () => {
    const { project, context } = projectOf({ "lib.ts": "export const unit = 2;\n" });
    const source =
      'import { unit } from "./lib";\n' +
      "export function scale(n) { return n * unit; }\n" +
      "export function shout(s) { return s.toUpperCase(); }\n";
    const outside = project.pathOf("outside.ts");
    const sPos = source.indexOf("s)") + 1;
    const run = annotateProject({
      types: [
        entry(outside, source.indexOf("n)") + 1, [["number"]]),
        entry(outside, sPos, [["number"]]),
      ],
      readFile: (path) => (path === outside ? source : undefined),
      oracle: { kind: "project", project: context },
    });
    expect(run.files.get(outside)!.text).toContain("scale(n: number)");
    expect(run.files.get(outside)!.skips).toContainEqual(
      expect.objectContaining({ pos: sPos, reason: "type-error" }),
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
