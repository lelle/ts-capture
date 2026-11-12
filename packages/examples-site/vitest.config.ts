import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    // The playground specs type-check against the full TypeScript libs. The
    // first check in a run took 5.5-7s under coverage on CI runners.
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.spec.ts",
        "src/build.ts",
        "src/playground/main.ts",
        "src/playground/worker.ts",
        "src/client/pages/*.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
