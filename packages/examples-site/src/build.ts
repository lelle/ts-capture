import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ExamplesData, renderPage } from "./page.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataPath = resolve(root, "docs/examples/examples.json");
const outPath = resolve(root, "site/index.html");

const data = JSON.parse(readFileSync(dataPath, "utf-8")) as ExamplesData;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, renderPage(data));
process.stdout.write(`${data.examples.length} examples -> ${outPath}\n`);
