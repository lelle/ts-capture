import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts"],
      reporter: ["text"],
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
