import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    // Each spec builds a TypeScript project and asks its checker, as core's
    // do. The first one in a file pays the compiler's cold start, which went
    // past the default 5s under coverage on CI runners.
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/test-utils/**"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
