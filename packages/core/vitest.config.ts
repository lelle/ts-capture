import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    // The cli / e2e / preload / setup / register specs run the *built*
    // package, so a `vitest run` without a build measures the previous one.
    // This rebuilds when a source file is newer than the artefacts, and does
    // nothing otherwise. See the file for what it cost to learn.
    globalSetup: ["./vitest.global-setup.ts"],
    // The e2e / cli specs spawn `node dist/cli.js` 2-3× per test (a full
    // instrument → run → apply pipeline, the runner subprocess alone allowed
    // 15s). Under v8 coverage on shared CI runners the default 5s per-test
    // timeout is far too tight and these flake out. Fast unit tests are
    // unaffected; a genuine hang still trips the subprocess-level timeouts.
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/cli.ts", "src/loader.ts", "src/register.ts"],
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
