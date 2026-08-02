import type { PluginObject, PluginPass } from "@babel/core" with {
  "resolution-mode": "import",
};

// ts-capture is ESM-only; Node 22+ supports require() of ESM packages so this
// works at runtime. We use plain require + a hand-written type to avoid
// TypeScript's CJS-imports-ESM static-check complaints.
type InstrumentFn = (
  source: string,
  fileName: string,
  options?: { skipTscptrDeclarations?: boolean },
) => string;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { instrumentSource } = require("@ts-capture/core") as {
  instrumentSource: InstrumentFn;
};

// @babel/core 8 is ESM-only; same require()-of-ESM pattern as above. The
// `typeof import(...)` alias keeps Babel's own signatures (incl. the
// non-exported ParseResult, which a top-of-file `import type` cannot name).
// eslint-disable-next-line no-restricted-syntax
type BabelCore = typeof import("@babel/core", {
  with: { "resolution-mode": "import" },
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseSync } = require("@babel/core") as BabelCore;

const TS_RE = /\.(ts|tsx|mts|cts)$/;
const ALREADY_INSTRUMENTED = Symbol.for(
  "@ts-capture/babel-plugin.alreadyInstrumented",
);

export interface TsCaptureBabelPluginOptions {
  /** Regex to exclude files from instrumentation. */
  exclude?: RegExp;
  /** Override the file extension regex (defaults to .ts/.tsx/.mts/.cts). */
  include?: RegExp;
}

/**
 * Babel plugin for ts-capture. Calls `ts-capture.instrumentSource` on each TypeScript file
 * Babel processes, then re-parses the instrumented source back into an AST
 * for the rest of the Babel pipeline.
 *
 * Pair with `@ts-capture/babel-plugin/runtime` (or a manual `globalThis.__tscptr__`
 * setup) so that the instrumented `__tscptr__(...)` calls have a function to
 * call at runtime.
 *
 * Usage in babel.config.js:
 *
 *   module.exports = {
 *     presets: ["@babel/preset-typescript"],
 *     plugins: ["@ts-capture/babel-plugin"],
 *   };
 */
function tsCaptureBabelPlugin(): PluginObject<PluginPass> {
  return {
    name: "ts-capture",
    visitor: {
      Program: {
        enter(path, state) {
          const filename = state.file.opts.filename;
          if (!filename) return;

          const opts = (state.opts ?? {}) as TsCaptureBabelPluginOptions;
          const includeRe = opts.include ?? TS_RE;
          if (!includeRe.test(filename)) return;
          if (opts.exclude?.test(filename)) return;

          // Re-parsed file re-enters this visitor; bail to avoid infinite loop.
          const fileMeta = state.file as unknown as Record<symbol, boolean>;
          if (fileMeta[ALREADY_INSTRUMENTED]) return;

          const source = state.file.code;
          const instrumented = instrumentSource(source, filename, {
            skipTscptrDeclarations: true,
          });

          const ast = parseSync(instrumented, {
            filename,
            sourceType: "module",
            babelrc: false,
            configFile: false,
            // Babel 8 removed isTSX/allExtensions — TS/TSX handling is
            // derived from the real filename passed above.
            presets: ["@babel/preset-typescript"],
          });

          if (!ast) return;

          fileMeta[ALREADY_INSTRUMENTED] = true;
          path.replaceWith(ast.program);
        },
      },
    },
  };
}

module.exports = tsCaptureBabelPlugin;
module.exports.default = tsCaptureBabelPlugin;
