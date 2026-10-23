import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { annotate } from "./annotate.js";
import {
  applyInMemory,
  createObserver,
  INFER_DEFAULTS,
  type InferOptions,
  instrumentSource,
} from "./browser.js";
import { locateSite } from "./cli/apply-report.js";
import { APPLY_RULES } from "./contract.js";

// One folder per rule apply decides by, each with files that end in that
// rule. Run the way the playground runs a file, so a corpus example and the
// playground cannot disagree about it. A file is a header of `//` lines, a
// blank line, and the code; only the code runs.

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../corpus");
const FILE = "/playground.ts";
const libDir = path.dirname(ts.getDefaultLibFilePath({}));

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  noEmit: true,
};

interface Example {
  rule: string;
  file: string;
  site: string;
  title: string;
  /** The code, without the header. */
  source: string;
  /**
   * `twice`: apply again to what the first apply wrote. `moved`: the code moved
   * a line after the run. `no-project`: apply with no tsconfig, so no checker.
   * `implicit-this`: observe `this` where TypeScript says it is implicitly `any`.
   */
  apply?: string;
  /** `name=true|false` pairs over the defaults, as `skipRedundantAnnotations=false`. */
  infer: Partial<InferOptions>;
}

const MOVED = "// A line added after the run moves everything below it.\n";

const isExample = (name: string) => name.endsWith(".ts") && !name.endsWith(".after.ts");

function inferFrom(header: string | undefined): Partial<InferOptions> {
  const pairs = (header ?? "").split(/\s+/).filter(Boolean);
  return Object.fromEntries(
    pairs.map((pair) => pair.split("=")).map(([k, v]) => [k, v === "true"]),
  );
}

const ruleFolders = (): string[] =>
  readdirSync(CORPUS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

function examples(): Example[] {
  return ruleFolders().flatMap((rule) =>
    readdirSync(path.join(CORPUS, rule))
      .filter(isExample)
      .map((name) => {
        const file = path.join(CORPUS, rule, name);
        const text = readFileSync(file, "utf-8");
        const split = text.indexOf("\n\n");
        const head = text.slice(0, split);
        const header = (key: string) => new RegExp(`^// ${key}: (.+)$`, "m").exec(head)?.[1];
        return {
          rule: header("rule") ?? "",
          file,
          site: header("site") ?? "",
          title: header("title") ?? "",
          source: text.slice(split + 2),
          apply: header("apply"),
          infer: inferFrom(header("infer")),
        };
      }),
  );
}

function memorySystem(source: string): ts.System {
  const read = (file: string): string | undefined =>
    file === FILE
      ? source
      : file.startsWith("/ts/")
        ? ts.sys.readFile(path.join(libDir, file.slice(4)))
        : undefined;
  return {
    ...ts.sys,
    useCaseSensitiveFileNames: true,
    getExecutingFilePath: () => "/ts/typescript.js",
    getCurrentDirectory: () => "/",
    readFile: read,
    fileExists: (file) => read(file) !== undefined,
    directoryExists: (dir) => dir === "/" || dir === "/ts",
    getDirectories: () => [],
    readDirectory: () => [],
  };
}

interface RunOptions {
  project?: boolean;
  implicitThis?: boolean;
  infer?: Partial<InferOptions>;
}

interface Decided {
  line: number;
  name: string;
  outcome: string;
  rule: string;
  type: string;
  detail?: string;
}

function programOf(source: string): ts.Program {
  const system = memorySystem(source);
  const host = ts.createCompilerHost(compilerOptions);
  host.readFile = system.readFile;
  host.fileExists = system.fileExists;
  host.getCurrentDirectory = () => "/";
  host.getDefaultLibLocation = () => "/ts";
  host.getSourceFile = (name, language) => {
    const text = system.readFile(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, language);
  };
  return ts.createProgram([FILE], compilerOptions, host);
}

/** Observe `source` running, and apply what was seen to `target`. */
async function run(
  source: string,
  target = source,
  { project = true, implicitThis = false, infer = {} }: RunOptions = {},
): Promise<{ after: string; decided: Decided[] }> {
  const observer = createObserver();
  const instrumented = instrumentSource(
    source,
    FILE,
    implicitThis ? { instrumentImplicitThis: true, program: programOf(source) } : undefined,
  );
  const js = ts.transpileModule(instrumented, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  new Function("__tscptr__", js)(observer.hook);
  const types = await observer.collect();
  const result = project
    ? applyInMemory({
        fileNames: [FILE],
        types,
        compilerOptions,
        rootDir: "/",
        system: memorySystem(target),
        infer: { ...INFER_DEFAULTS, ...infer },
      })
    : located(target, annotate(target, types, { filename: FILE, infer }));
  const decided: Decided[] = [
    ...result.written.map((w) => ({ ...w, outcome: "written" })),
    ...result.skips.map((s) => ({ ...s, outcome: s.reason, rule: s.rule ?? "", type: s.observed })),
  ].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return { after: result.files[FILE] ?? target, decided };
}

function located(source: string, result: ReturnType<typeof annotate>) {
  return {
    files: { [FILE]: result.text },
    skips: result.skips.map((skip) => locateSite(skip, FILE, source)),
    written: (result.telemetry.written ?? []).map((write) => locateSite(write, FILE, source)),
  };
}

const TYPE_LIMIT = 200;

// The file as apply leaves it, then what it decided at each site.
function answerKey(after: string, decided: Decided[]): string {
  const lines = decided.map(
    (d) =>
      `L${d.line} ${d.name}: ${d.outcome} (${d.rule}) ` +
      (d.type.length > TYPE_LIMIT ? `${d.type.slice(0, TYPE_LIMIT)}…` : d.type) +
      (d.detail ? ` — ${d.detail}` : ""),
  );
  return `${after}\n/* Generated by corpus.spec.ts; run vitest -u to update.\n${lines.join("\n")}\n*/\n`;
}

describe("corpus: each example ends in the rule its folder names", () => {
  it.each(examples().map((e) => [path.relative(CORPUS, e.file), e] as const))(
    "%s",
    async (_, example) => {
      expect(example.rule, "the header's rule").toBe(path.basename(path.dirname(example.file)));
      expect(example.title, "the header's title").not.toBe("");
      const { source } = example;
      const options: RunOptions = {
        project: example.apply !== "no-project",
        implicitThis: example.apply === "implicit-this",
        infer: example.infer,
      };
      const target =
        example.apply === "twice"
          ? (await run(source, source, options)).after
          : example.apply === "moved"
            ? MOVED + source
            : source;
      const { after, decided } = await run(source, target, options);
      await expect(answerKey(after, decided)).toMatchFileSnapshot(
        example.file.replace(/\.ts$/, ".after.ts"),
      );
      // Moved code's positions no longer point at the site they were recorded for.
      const atSite = decided.filter((d) => example.apply === "moved" || d.name === example.site);
      expect(atSite.map((d) => d.rule)).toContain(example.rule);
    },
  );
});

describe("corpus: completeness", () => {
  const folders = ruleFolders();

  it("has an example of every rule", () => {
    const empty = APPLY_RULES.filter(
      (rule) => !folders.includes(rule) || !readdirSync(path.join(CORPUS, rule)).some(isExample),
    );
    expect(empty).toEqual([]);
  });

  it("explains every rule in a README that leads with its title", () => {
    const missing = folders.filter((folder) => {
      const readme = path.join(CORPUS, folder, "README.md");
      return !existsSync(readme) || !readFileSync(readme, "utf-8").startsWith("# ");
    });
    expect(missing).toEqual([]);
  });

  it("titles every example apart from every rule and from its rule's other examples", () => {
    const ruleTitles = folders.map((folder) =>
      readFileSync(path.join(CORPUS, folder, "README.md"), "utf-8")
        .split("\n")[0]!
        .slice(2),
    );
    const repeated = folders.flatMap((folder) => {
      const titles = examples()
        .filter((e) => e.rule === folder)
        .map((e) => e.title);
      return titles
        .filter((title, i) => ruleTitles.includes(title) || titles.indexOf(title) !== i)
        .map((title) => `${folder}: ${title}`);
    });
    expect(repeated).toEqual([]);
  });

  it("names no folder after a rule that does not exist", () => {
    expect(
      folders.filter((folder) => !(APPLY_RULES as readonly string[]).includes(folder)),
    ).toEqual([]);
  });
});
