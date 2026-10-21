import { defineConfig } from "vite";

// Serves the built site/ as GitHub Pages does: under /ts-capture/, and a
// missing page is the 404 page, not the front page.
export default defineConfig({
  appType: "mpa",
  base: "/ts-capture/",
  build: { outDir: "../../site" },
});
