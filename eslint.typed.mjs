import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

// Type-aware correctness rules — they need the TypeScript program, so oxlint
// and the default (fast) eslint.config.mjs can't run them. Curated for this
// codebase: the high-value, low-noise typed rules, deliberately EXCLUDING the
// `no-unsafe-*` family (which a value-walker that traverses `unknown`/`any`
// boundaries trips constantly). Run via `pnpm lint:types` in CI / pre-push;
// kept out of the default config so the pre-commit lint stays fast.
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/examples/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["packages/*/tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      // Async / promise correctness (all 0 findings today — future guards).
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/restrict-plus-operands": "error",
      "@typescript-eslint/no-base-to-string": "error",
      // Correctness guards. unbound-method is intentionally NOT enabled — here it
      // only flags idiomatic `ts.sys.*` compiler-host wiring (this-free methods).
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-implied-eval": "error",
      "@typescript-eslint/no-unsafe-enum-comparison": "error",
      "@typescript-eslint/no-require-imports": "error",
    },
  },
  {
    // Specs intentionally model async functions (fixtures whose Promise type is
    // under test) and use `new Function` to execute generated code.
    files: ["**/*.spec.{ts,tsx}"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-implied-eval": "off",
    },
  },
];
