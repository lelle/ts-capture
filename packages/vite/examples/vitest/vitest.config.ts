import tsCapture from "@ts-capture/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsCapture()],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
