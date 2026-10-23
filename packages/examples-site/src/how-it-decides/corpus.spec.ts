import { APPLY_RULES } from "@ts-capture/core/browser";
import { createDefaultMapFromNodeModules } from "@typescript/vfs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { reachableLibs } from "../playground/libs.js";
import { COMPILER_OPTIONS } from "../playground/run.js";
import { CORPUS_DIR, parseExample, published, readCorpus } from "./corpus.js";
import { decide } from "./decide.js";
import { DECIDED_BY, STAGES } from "./rules.js";

const libs = reachableLibs(
  createDefaultMapFromNodeModules(COMPILER_OPTIONS, ts),
  ["/lib.es2022.d.ts"],
);
const coreSrc = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../core/src",
);
const examplesJson = JSON.parse(
  readFileSync(
    resolve(coreSrc, "../../../docs/examples/examples.json"),
    "utf-8",
  ),
) as { examples: { id: string }[] };
const rules = readCorpus();

describe("parseExample", () => {
  const text =
    "// rule: gate.erases-enum\n" +
    "// site: mode\n" +
    "// title: An enum would become its values\n" +
    "// real: a, b\n" +
    "// apply: twice\n" +
    "// infer: skipRedundantAnnotations=false\n" +
    "// verdict: ok\n" +
    "// TypeScript has the enum.\n" +
    "// The run sees the string.\n" +
    "\n" +
    "// @ts-capture-ignore\n" +
    "enum Mode {}\n";

  it("reads the header, and the code after the blank line", () => {
    expect(parseExample("gate.erases-enum", "enum-parameter", text)).toEqual({
      rule: "gate.erases-enum",
      name: "enum-parameter",
      site: "mode",
      title: "An enum would become its values",
      real: ["a", "b"],
      apply: "twice",
      infer: { skipRedundantAnnotations: false },
      verdict: "ok",
      why: "TypeScript has the enum. The run sees the string.",
      code: "// @ts-capture-ignore\nenum Mode {}\n",
    });
  });
});

describe("the corpus, as the page reads it", () => {
  it("has every rule, with its title and what it is about", () => {
    expect(rules.map((rule) => rule.id).sort()).toEqual(
      [...APPLY_RULES].sort(),
    );
    for (const rule of rules) {
      expect(rule.title, rule.id).not.toBe("");
      expect(rule.about, rule.id).not.toBe("");
    }
  });

  it("puts every rule in one stage", () => {
    const staged = STAGES.flatMap((stage) => stage.rules);
    expect([...staged].sort()).toEqual([...APPLY_RULES].sort());
  });

  it("leaves a questionable example off the page", () => {
    const shown = rules.flatMap((rule) => published(rule.examples));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((example) => example.verdict === "ok")).toBe(true);
  });

  it("names a function that decides each rule", () => {
    for (const rule of APPLY_RULES) {
      const { file, symbol } = DECIDED_BY[rule];
      const source = readFileSync(resolve(coreSrc, file), "utf-8");
      expect(source, rule).toMatch(new RegExp(`function ${symbol}\\b`));
    }
  });

  it("places only real examples that exist", () => {
    const ids = new Set(examplesJson.examples.map((example) => example.id));
    for (const rule of rules)
      for (const example of rule.examples)
        for (const id of example.real)
          expect(ids, `${rule.id}/${example.name}`).toContain(id);
  });
});

// The page runs each example the way the playground does; the corpus spec in
// core ran it the same way and kept the result. They must agree.
describe("each example on the page is what the corpus says", () => {
  const shown = rules.flatMap((rule) => published(rule.examples));
  it.each(
    shown.map(
      (example) => [`${example.rule}/${example.name}`, example] as const,
    ),
  )("%s", async (_, example) => {
    const decided = await decide(example, libs);
    const key = readFileSync(
      resolve(CORPUS_DIR, example.rule, `${example.name}.after.ts`),
      "utf-8",
    );
    expect(decided.after).toBe(key.slice(0, key.indexOf("\n/* Generated")));
    expect(decided.atSite?.rule).toBe(example.rule);
  });
});

describe("the kind of position an example stands at", () => {
  it("is the declaration the run points at, where the name is declared twice", async () => {
    // `word` is a loop variable inside `each`, and the callback's parameter.
    const example = rules
      .find((rule) => rule.id === "gate.contradiction")!
      .examples.find(
        (e) => e.name === "parameter-the-run-disagrees-with-typescript",
      )!;
    expect((await decide(example, libs)).kind).toBe("parameter");
  });
});
