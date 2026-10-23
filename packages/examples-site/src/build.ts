import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildInfo } from "./layout.js";

import { createCodeHighlighter } from "./docs/highlight.js";
import { renderDocsSite } from "./docs/site.js";
import { renderHomePage } from "./home.js";
import { published, readCorpus } from "./how-it-decides/corpus.js";
import { decide } from "./how-it-decides/decide.js";
import { renderDecidesPage, ruleLinks } from "./how-it-decides/page.js";
import { renderNotFoundPage } from "./not-found.js";
import { type ExamplesData, renderPage } from "./page.js";
import { playgroundLibs } from "./playground/libs.js";
import { renderPlaygroundPage } from "./playground/page.js";
import { STARTERS } from "./playground/starters.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageDir, "../..");
const docsDir = resolve(root, "docs");
const dataPath = resolve(docsDir, "examples/examples.json");
const outDir = resolve(root, "site");
const examplesDir = resolve(outDir, "examples");
const playgroundDir = resolve(outDir, "playground");
const decidesDir = resolve(outDir, "how-it-decides");

const data = JSON.parse(readFileSync(dataPath, "utf-8")) as ExamplesData;
const buildInfo: BuildInfo = {
  version: (
    JSON.parse(
      readFileSync(resolve(root, "packages/core/package.json"), "utf-8"),
    ) as { version: string }
  ).version,
  commit: currentCommit(),
  // The version PR consumes the changesets, so any left mean main is ahead.
  unreleased: readdirSync(resolve(root, ".changeset")).some(
    (name) => name.endsWith(".md") && name !== "README.md",
  ),
};
mkdirSync(playgroundDir, { recursive: true });
mkdirSync(examplesDir, { recursive: true });
writeFileSync(resolve(outDir, "index.html"), renderHomePage(buildInfo));
writeFileSync(resolve(outDir, "404.html"), renderNotFoundPage(buildInfo));
const stylesDir = resolve(packageDir, "src/styles");
mkdirSync(resolve(outDir, "css"), { recursive: true });
for (const sheet of readdirSync(stylesDir)) {
  copyFileSync(resolve(stylesDir, sheet), resolve(outDir, "css", sheet));
}
// The recording's stills (not the README's animation) and the share card.
const assetsDir = resolve(root, "docs/assets");
for (const asset of readdirSync(assetsDir)) {
  if (/^demo-\d/.test(asset) || asset === "og.png") {
    copyFileSync(resolve(assetsDir, asset), resolve(outDir, asset));
  }
}
const libs = playgroundLibs();
// Each corpus example is run when the page is built, the same way the
// playground runs a file. Examples links to the ones that stand for its own.
const rules = await Promise.all(
  readCorpus().map(async (rule) => ({
    rule,
    examples: await Promise.all(
      published(rule.examples).map((example) => decide(example, libs)),
    ),
  })),
);

writeFileSync(
  resolve(examplesDir, "index.html"),
  renderPage(data, buildInfo, ruleLinks(rules)),
);
process.stdout.write(
  `${data.examples.length} examples -> ${examplesDir}/index.html\n`,
);

writeFileSync(resolve(playgroundDir, "libs.json"), JSON.stringify([...libs]));
writeFileSync(
  resolve(playgroundDir, "index.html"),
  renderPlaygroundPage(STARTERS, buildInfo),
);

mkdirSync(decidesDir, { recursive: true });
writeFileSync(
  resolve(decidesDir, "index.html"),
  renderDecidesPage(rules, data, buildInfo),
);
process.stdout.write(`${rules.length} rules -> ${decidesDir}/index.html\n`);

const docs = renderDocsSite(
  (file) => readFileSync(resolve(docsDir, file), "utf-8"),
  buildInfo,
  await createCodeHighlighter(),
);
for (const [path, html] of docs) {
  mkdirSync(resolve(outDir, path), { recursive: true });
  writeFileSync(resolve(outDir, path, "index.html"), html);
}
process.stdout.write(`${docs.size} docs pages -> ${outDir}/docs/\n`);
const bundled = {
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "warning",
} as const;
await Promise.all([
  build({
    ...bundled,
    entryPoints: ["home", "examples", "how-it-decides", "docs", "theme"].map(
      (page) => resolve(packageDir, `src/client/pages/${page}.ts`),
    ),
    outdir: resolve(outDir, "js"),
  }),
  build({
    ...bundled,
    entryPoints: {
      main: resolve(packageDir, "src/playground/main.ts"),
      worker: resolve(packageDir, "src/playground/worker.ts"),
    },
    outdir: playgroundDir,
    // @typescript/vfs requires these inside its Node-only helpers, which the page never calls.
    external: ["fs", "path"],
  }),
]);
process.stdout.write(
  `${STARTERS.length} starters -> ${playgroundDir}/index.html\n`,
);

function currentCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}
