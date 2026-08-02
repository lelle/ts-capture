import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import jsdoc from "eslint-plugin-jsdoc";
import perfectionist from "eslint-plugin-perfectionist";
import regexp from "eslint-plugin-regexp";

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
  },
  regexp.configs["flat/recommended"],
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin, perfectionist },
    rules: {
      // Strict regex form: escape `{` `}` `]` etc. so patterns stay valid under
      // the `u`/`v` flag (where a bare `}`/`]` is a SyntaxError). This re-adds
      // escapes that WebStorm's "Redundant character escape" inspection flags —
      // disable that inspection (or live with the noise) to avoid the tug-of-war.
      "regexp/strict": "error",
      // ReDoS guard: reject regexes with polynomial/exponential backtracking
      // (recommended-default; previously disabled, re-enabled after fixing hits).
      "regexp/no-super-linear-backtracking": "error",
      // Subtle semantics around Unicode case-folding. Address manually if at all.
      "regexp/use-ignore-case": "off",
      // Import ordering only — deliberately NOT the full perfectionist
      // recommended set (object/interface member sorting is noisy and
      // occasionally semantic). Auto-fixable; keeps import blocks drift-free.
      "perfectionist/sort-imports": ["error", { type: "natural" }],
      "perfectionist/sort-named-imports": ["error", { type: "natural" }],
      // Type-quality guards. Both patterns are syntactic smells that a
      // named alias reads better than: prefer a top-of-file `import type`
      // over an inline `import("...").Foo`, and name a tuple/element type
      // (e.g. `DiscoveredType`) instead of reaching into it with a numeric
      // indexed-access (`CollectedTypeInfo[number][2]`). Element access via
      // `Foo[number]` and named-property access via `Foo["key"]` are left
      // alone — they're often legitimate.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSImportType",
          message:
            'Inline import() type — use a top-of-file `import type { Foo } from "..."` instead.',
        },
        {
          selector:
            "TSIndexedAccessType > TSLiteralType > Literal[raw=/^-?[0-9]/]",
          message:
            "Numeric indexed-access type — give the tuple/element a named alias instead of indexing into it.",
        },
      ],
    },
  },
  {
    // JSDoc enforcement scoped to the PUBLIC SURFACE only — core's `index.ts`
    // re-export barrel, which defines the package's exported API. Every
    // re-export statement must carry a one-line JSDoc so IDE hover / TypeDoc
    // document the public symbols. Internals stay free of mandatory JSDoc
    // (they use rich inline "why" comments instead); the other packages'
    // index.ts mix declarations and are out of scope for this gate.
    files: ["packages/core/src/index.ts"],
    plugins: { jsdoc },
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        { contexts: ["ExportNamedDeclaration", "ExportAllDeclaration"] },
      ],
    },
  },
];
