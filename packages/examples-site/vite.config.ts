import { defineConfig } from "vite";

// Serves the built site/ as GitHub Pages does: a missing page is a 404, not
// the front page.
export default defineConfig({
  appType: "mpa",
  build: { outDir: "../../site" },
});
