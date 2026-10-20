import { createDefaultMapFromNodeModules } from "@typescript/vfs";
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { renderHomePage } from "./home.js";
import { CELLS } from "./how-it-decides/cells.js";
import { decide } from "./how-it-decides/decide.js";
import { renderDecidesPage } from "./how-it-decides/page.js";
import { type ExamplesData, renderPage } from "./page.js";
import { reachableLibs } from "./playground/libs.js";
import { renderPlaygroundPage } from "./playground/page.js";
import { COMPILER_OPTIONS } from "./playground/run.js";
import { STARTERS } from "./playground/starters.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageDir, "../..");
const dataPath = resolve(root, "docs/examples/examples.json");
const outDir = resolve(root, "site");
const examplesDir = resolve(outDir, "examples");
const playgroundDir = resolve(outDir, "playground");
const decidesDir = resolve(outDir, "how-it-decides");

const data = JSON.parse(readFileSync(dataPath, "utf-8")) as ExamplesData;
mkdirSync(playgroundDir, { recursive: true });
mkdirSync(examplesDir, { recursive: true });
writeFileSync(resolve(outDir, "index.html"), renderHomePage());
copyFileSync(
  resolve(root, "docs/assets/demo.mp4"),
  resolve(outDir, "demo.mp4"),
);
writeFileSync(resolve(examplesDir, "index.html"), renderPage(data));
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
  renderPlaygroundPage(STARTERS),
);

// Each card is run when the page is built, the same way the playground runs a file.
const decided = await Promise.all(CELLS.map((cell) => decide(cell, libs)));
mkdirSync(decidesDir, { recursive: true });
writeFileSync(
  resolve(decidesDir, "index.html"),
  renderDecidesPage(
    decided,
    new Map(data.examples.map((example) => [example.id, example.title])),
  ),
);
process.stdout.write(`${decided.length} cells -> ${decidesDir}/index.html\n`);
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
