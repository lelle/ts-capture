import { createDefaultMapFromNodeModules } from "@typescript/vfs";
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
import ts from "typescript";

import type { BuildInfo } from "./frame.js";

import { createCodeHighlighter } from "./docs/highlight.js";
import { renderDocsSite } from "./docs/site.js";
import { renderHomePage } from "./home.js";
import { CELLS } from "./how-it-decides/cells.js";
import { decide } from "./how-it-decides/decide.js";
import { renderDecidesPage, ruleLinks } from "./how-it-decides/page.js";
import { type ExamplesData, renderPage } from "./page.js";
import { reachableLibs } from "./playground/libs.js";
import { renderPlaygroundPage } from "./playground/page.js";
import { COMPILER_OPTIONS } from "./playground/run.js";
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
copyFileSync(
  resolve(root, "docs/assets/demo.mp4"),
  resolve(outDir, "demo.mp4"),
);
writeFileSync(
  resolve(examplesDir, "index.html"),
  renderPage(data, buildInfo, ruleLinks(CELLS)),
);
process.stdout.write(
  `${data.examples.length} examples -> ${examplesDir}/index.html\n`,
);

const libs = reachableLibs(
  createDefaultMapFromNodeModules(COMPILER_OPTIONS, ts),
  (COMPILER_OPTIONS.lib ?? []).map((lib) => `/${lib}`),
);
writeFileSync(resolve(playgroundDir, "libs.json"), JSON.stringify([...libs]));
writeFileSync(
  resolve(playgroundDir, "index.html"),
  renderPlaygroundPage(STARTERS, buildInfo),
);

// Each card is run when the page is built, the same way the playground runs a file.
const decided = await Promise.all(CELLS.map((cell) => decide(cell, libs)));
mkdirSync(decidesDir, { recursive: true });
writeFileSync(
  resolve(decidesDir, "index.html"),
  renderDecidesPage(decided, data, buildInfo),
);
process.stdout.write(`${decided.length} cells -> ${decidesDir}/index.html\n`);

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
await build({
  entryPoints: {
    main: resolve(packageDir, "src/playground/main.ts"),
    worker: resolve(packageDir, "src/playground/worker.ts"),
  },
  outdir: playgroundDir,
  bundle: true,
  platform: "browser",
  // @typescript/vfs requires these inside its Node-only helpers, which the page never calls.
  external: ["fs", "path"],
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "warning",
});
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
