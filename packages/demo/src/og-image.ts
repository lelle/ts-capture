import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

import { PACKAGE_DIR } from "./run.js";
import { SHARE_CARD, shareCardHtml } from "./share-card.js";

// Draws the share card to docs/assets/og.png, which the site build copies.
// Run by hand, like the recording, when the card or its example changes.

const DOCS = path.resolve(PACKAGE_DIR, "..", "..", "docs");
const EXAMPLE = "params-and-return";

const { examples } = JSON.parse(
  fs.readFileSync(path.join(DOCS, "examples", "examples.json"), "utf-8"),
) as { examples: { id: string; before: string; after: string }[] };
const example = examples.find((candidate) => candidate.id === EXAMPLE);
if (!example) throw new Error(`examples.json has no ${EXAMPLE}`);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: SHARE_CARD });
  await page.setContent(shareCardHtml(example));
  await page.screenshot({ path: path.join(DOCS, "assets", "og.png") });
} finally {
  await browser.close();
}
