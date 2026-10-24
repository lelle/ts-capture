import type {
  ApplyRule,
  ApplySkipReason,
  InferOptions,
} from "@ts-capture/core/browser";

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The page's examples are core's corpus: one folder per rule, a README about
// the rule, and example files whose header says what the page shows. Core's
// corpus spec checks that each example ends in its folder's rule.

export type SiteKind =
  "parameter" | "return" | "variable" | "field" | "callback" | "this";

export type Outcome = "written" | ApplySkipReason;

export const OUTCOMES: Outcome[] = [
  "written",
  "type-error",
  "no-information",
  "out-of-scope",
  "contradiction",
  "redundant",
  "kept-existing",
  "already-annotated",
  "ignored",
  "left-to-typescript",
  "no-site",
];

export interface CorpusExample {
  rule: ApplyRule;
  /** The file name, without `.ts`. */
  name: string;
  /** The site's name in the code, or `return type` / `this`. */
  site: string;
  title: string;
  /** Ids in `docs/examples/examples.json` this example stands for. */
  real: string[];
  apply?: "twice" | "moved" | "no-project" | "implicit-this";
  infer: Partial<InferOptions>;
  verdict: "ok" | "questionable";
  /** Why apply does this, for the reader. */
  why: string;
  code: string;
}

export interface CorpusRule {
  id: ApplyRule;
  title: string;
  about: string;
  examples: CorpusExample[];
}

export const CORPUS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../core/corpus",
);

/** `true`, `false` and numbers as what they say; anything else as text. */
function optionValue(value = ""): boolean | number | string {
  if (value === "true" || value === "false") return value === "true";
  return /^\d+$/.test(value) ? Number(value) : value;
}

const KEY = /^\/\/ (rule|site|title|real|apply|infer|verdict): (.*)$/;

/** One example file: a header of `//` lines, a blank line, then the code. */
export function parseExample(
  rule: string,
  name: string,
  text: string,
): CorpusExample {
  const split = text.indexOf("\n\n");
  const keys = new Map<string, string>();
  const why: string[] = [];
  for (const line of text.slice(0, split).split("\n")) {
    const key = KEY.exec(line);
    if (key) keys.set(key[1], key[2]);
    else why.push(line.replace(/^\/\/ ?/, ""));
  }
  const pairs = (keys.get("infer") ?? "").split(/\s+/).filter(Boolean);
  return {
    rule: rule as ApplyRule,
    name,
    site: keys.get("site") ?? "",
    title: keys.get("title") ?? "",
    real: (keys.get("real") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    ...(keys.has("apply")
      ? { apply: keys.get("apply") as CorpusExample["apply"] }
      : {}),
    infer: Object.fromEntries(
      pairs
        .map((pair) => pair.split("="))
        .map(([key, value]) => [key, optionValue(value)]),
    ),
    verdict: keys.get("verdict") === "ok" ? "ok" : "questionable",
    why: why.join(" "),
    code: text.slice(split + 2),
  };
}

/** Every rule in the corpus, with its README's title and paragraph. */
export function readCorpus(dir = CORPUS_DIR): CorpusRule[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name: id }) => {
      const files = readdirSync(resolve(dir, id));
      const [heading = "", ...rest] = readFileSync(
        resolve(dir, id, "README.md"),
        "utf-8",
      ).split("\n");
      return {
        id: id as ApplyRule,
        title: heading.replace(/^# /, ""),
        about: rest.join(" ").replace(/\s+/g, " ").trim(),
        examples: files
          .filter((file) => file.endsWith(".ts") && !file.endsWith(".after.ts"))
          .map((file) =>
            parseExample(
              id,
              file.slice(0, -3),
              readFileSync(resolve(dir, id, file), "utf-8"),
            ),
          ),
      };
    });
}

/** The examples the page shows: a questionable one stays off it until it is settled. */
export const published = (examples: CorpusExample[]): CorpusExample[] =>
  examples.filter((example) => example.verdict === "ok");
