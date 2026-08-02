import type { BuildOptions, Plugin, PluginBuild } from "esbuild";

import { instrumentSource } from "@ts-capture/core";
import fs from "node:fs";
import path from "node:path";

const TS_RE = /\.(ts|tsx|mts|cts)$/;

export interface TsCaptureEsbuildPluginOptions {
  /**
   * Regex to whitelist files for instrumentation. When set, only files
   * matching this AND the built-in `.ts/.tsx/.mts/.cts` filter are
   * instrumented. Combine with `exclude` to subtract from the whitelist.
   * When unset, all `.ts/.tsx/.mts/.cts` files are candidates (subject
   * to `exclude`).
   */
  include?: RegExp;
  /** Regex to exclude files from instrumentation. */
  exclude?: RegExp;
  /**
   * When `true`, prepend `require("@ts-capture/core/preload")` at the top of
   * every entry file (per `build.initialOptions.entryPoints`) so users
   * don't need to set `NODE_OPTIONS='--require @ts-capture/core/preload'` to
   * bootstrap the runtime. Only entry files get the prefix — bundled
   * non-entry modules wouldn't benefit (Node's module cache makes a
   * second require a no-op, but the bundle gets noisier).
   *
   * Default: `false`. The documented zero-config path is the explicit
   * `NODE_OPTIONS='--require @ts-capture/core/preload' node dist/bundle.js`
   * incantation, mirroring `@ts-capture/babel-plugin`.
   *
   * Limitation: when the bundle's output `format` is ESM, a CJS
   * `require` call breaks at runtime. Use only with CJS outputs, or
   * stick with the NODE_OPTIONS path.
   */
  injectRuntime?: boolean;
}

/**
 * esbuild plugin for ts-capture. Intercepts TS file loads, instruments the
 * source via `@ts-capture/core` so test/demo runs collect runtime type
 * observations, then hands the transformed code back to esbuild as
 * `loader: "ts" | "tsx"` so esbuild's normal TS→JS pipeline finishes the
 * compile.
 *
 * Pair with `@ts-capture/core/preload` (loaded via NODE_OPTIONS preload, or
 * opt-in via `injectRuntime: true`) so the instrumented `__tscptr__(...)`
 * calls have a function to call at runtime.
 *
 * Source-map caveat: `instrumentSource()` shifts positions in the source. The
 * source map esbuild generates therefore points at the INSTRUMENTED
 * positions, not the original. Acceptable for v1 — matches the
 * `@ts-capture/vite` plugin's behavior (`map: null`). A precise position
 * remap would require threading instrumentSource()'s position table through
 * a hand-built source map, which is deferred.
 *
 * Usage with tsup:
 *
 *   // tsup.config.ts
 *   import { defineConfig } from "tsup";
 *   import { tsCaptureEsbuildPlugin } from "@ts-capture/esbuild";
 *
 *   export default defineConfig({
 *     entry: ["src/index.ts"],
 *     esbuildPlugins: [tsCaptureEsbuildPlugin()],
 *   });
 *
 *   // Run the built artifact with the runtime preload:
 *   //   NODE_OPTIONS='--require @ts-capture/core/preload' node dist/index.js
 */
export function tsCaptureEsbuildPlugin(
  options: TsCaptureEsbuildPluginOptions = {},
): Plugin {
  return {
    name: "ts-capture",
    setup(build: PluginBuild) {
      // Resolve entry paths once per build. esbuild's `entryPoints` field
      // has three legal shapes — `string[]`, `Record<string, string>`,
      // and `Array<{ in: string; out: string }>` — so we normalize them
      // to a Set of absolute paths at onStart time when initialOptions
      // is stable, and reuse it across all onLoad invocations.
      const entryPaths = new Set<string>();
      if (options.injectRuntime) {
        build.onStart(() => {
          entryPaths.clear();
          collectEntryPaths(build.initialOptions.entryPoints, entryPaths);
        });
      }

      build.onLoad({ filter: TS_RE }, async (args) => {
        if (options.include && !options.include.test(args.path)) return null;
        if (options.exclude?.test(args.path)) return null;

        const source = await fs.promises.readFile(args.path, "utf-8");
        let contents = instrumentSource(source, args.path, {
          skipTscptrDeclarations: true,
        });

        if (options.injectRuntime && entryPaths.has(args.path)) {
          contents = `require("@ts-capture/core/preload");\n${contents}`;
        }

        // esbuild only has dedicated `ts` and `tsx` loaders — `.mts` and
        // `.cts` use the `ts` loader (esbuild infers ESM/CJS from the
        // extension or output format). Only `.tsx` needs the JSX loader.
        const loader = args.path.endsWith(".tsx") ? "tsx" : "ts";
        return { contents, loader };
      });
    },
  };
}

type EntryPointsInput = BuildOptions["entryPoints"];

function collectEntryPaths(eps: EntryPointsInput, out: Set<string>): void {
  if (!eps) return;
  if (Array.isArray(eps)) {
    for (const e of eps) {
      const p = typeof e === "string" ? e : e.in;
      if (typeof p === "string") out.add(canonicalize(p));
    }
    return;
  }
  if (typeof eps === "object") {
    for (const v of Object.values(eps)) {
      if (typeof v === "string") out.add(canonicalize(v));
    }
  }
}

// esbuild's `args.path` in onLoad is the canonicalized real path of
// the file (symlinks resolved). User-supplied entry paths may be a
// symlinked path that points at the same file — most visibly on
// macOS where `os.tmpdir()` returns `/var/folders/...` but the
// actual path is `/private/var/folders/...`. Canonicalize entries
// at collection time so the membership check inside onLoad matches.
function canonicalize(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

export default tsCaptureEsbuildPlugin;
