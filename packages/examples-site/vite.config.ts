import { defineConfig } from "vite";

import { SITE_ROOT } from "./src/layout.js";

// Serves the built site/ as GitHub Pages does: under /ts-capture/, and a
// missing page is the 404 page, not the front page.
export default defineConfig({
  appType: "mpa",
  base: SITE_ROOT,
  build: { outDir: "../../site" },
});
