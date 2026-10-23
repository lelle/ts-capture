import { readdirSync, readFileSync } from "node:fs";
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
// playground cannot disagree about it.

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
  source: string;
  /**
   * `twice`: apply again to what the first apply wrote. `moved`: the code moved
   * a line after the run. `no-project`: apply with no tsconfig, so no checker.
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
        const source = readFileSync(file, "utf-8");
        const header = (key: string) => new RegExp(`^// ${key}: (.+)$`, "m").exec(source)?.[1];
        return {
          rule: header("rule") ?? "",
          file,
          site: header("site") ?? "",
          source,
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

interface Decided {
  line: number;
  name: string;
  outcome: string;
  rule: string;
  type: string;
  detail?: string;
}

/** Observe `source` running, and apply what was seen to `target`. */
async function run(
  source: string,
  target = source,
  project = true,
  infer: Partial<InferOptions> = {},
): Promise<{ after: string; decided: Decided[] }> {
  const observer = createObserver();
  const js = ts.transpileModule(instrumentSource(source, FILE), {
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
      const { source } = example;
      const target =
        example.apply === "twice"
          ? (await run(source)).after
          : example.apply === "moved"
            ? MOVED + source
            : source;
      const { after, decided } = await run(
        source,
        target,
        example.apply !== "no-project",
        example.infer,
      );
      await expect(answerKey(after, decided)).toMatchFileSnapshot(
        example.file.replace(/\.ts$/, ".after.ts"),
      );
      // `*`: the positions no longer name the site, as when the code moved.
      const atSite = decided.filter((d) => example.site === "*" || d.name === example.site);
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

  it("names no folder after a rule that does not exist", () => {
    expect(
      folders.filter((folder) => !(APPLY_RULES as readonly string[]).includes(folder)),
    ).toEqual([]);
  });
});
