/**
 * Applier-plugin hook.
 *
 * Surfaces a small extension point so file-type-aware appliers
 * (@ts-capture/svelte today, plausibly @ts-capture/vue, /astro, /mdx
 * tomorrow) can route their own observations through `cmdApply`
 * without core needing to import every adapter package.
 *
 * Dep direction stays clean: adapters depend on core, never the
 * other way. The plugin contract is defined here; the adapter's
 * own module exports a factory that returns one. The CLI
 * dynamic-imports the user's `ts-capture.config.{mjs,js,cjs}` and
 * reads `config.plugins`.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ApplyTypesOptions } from "./contract.js";
import type { CollectedTypeInfo } from "./type-collector.js";
export interface ApplierPlugin {
  /** Short name for logging. */
  name: string;
  /**
   * Predicate over a file path from a types-info entry. First match
   * wins in the dispatch loop, so plugins should keep their
   * predicates specific (e.g. a regex on the synthetic suffix).
   */
  match: (filePath: string) => boolean;
  /**
   * Map the (possibly synthetic) file path back to the real
   * on-disk source file the plugin owns. The CLI uses this to
   * decide which file to `fs.readFileSync` and `fs.writeFileSync`
   * against. For Svelte: `Component.svelte__script.ts` →
   * `Component.svelte`.
   */
  resolveSourceFile: (filePath: string) => string;
  /**
   * Run the plugin's apply step. Receives the resolved source
   * (already read from disk by the CLI), all entries that routed
   * to this source file (possibly from MULTIPLE virtual paths —
   * e.g. both `__script.ts` and `__module.ts` for the same
   * `.svelte`), and the same ApplyTypesOptions the built-in
   * applier would get. Must return the modified source verbatim
   * (or the input unchanged if nothing applied).
   *
   * The plugin is responsible for any framework-specific logic
   * (parsing `.svelte` blocks, mapping offsets, etc.). Core does
   * not assume any particular structure beyond "source string in,
   * source string out".
   */
  apply: (source: string, entries: CollectedTypeInfo, options: ApplyTypesOptions) => string;
}

export interface PluginRouting {
  /** The plugin that claimed this file, or null = built-in applier. */
  plugin: ApplierPlugin | null;
  /** The on-disk source file to read/write. */
  sourceFile: string;
}

/**
 * Resolve which plugin (if any) owns a file. First-match-wins
 * across the registered plugin list; if none match, returns
 * `{ plugin: null, sourceFile: filePath }` so the caller falls
 * through to the built-in applier on the original path.
 */
export function routeFile(filePath: string, plugins: readonly ApplierPlugin[]): PluginRouting {
  for (const p of plugins) {
    if (p.match(filePath)) {
      return { plugin: p, sourceFile: p.resolveSourceFile(filePath) };
    }
  }
  return { plugin: null, sourceFile: filePath };
}

/**
 * Auto-discover and load applier plugins from a JS-format
 * ts-capture config file (`ts-capture.config.{mjs,js,cjs}`) next
 * to the project. JSON config (`ts-capture.config.json`) is for
 * static options only — plugins are functions and can't be
 * expressed in JSON cleanly.
 *
 * Returns an empty array when no JS config is found or the config
 * has no `plugins` export. This is the "default behavior
 * unchanged" path that keeps the safety-net warning for synthetic
 * paths working for users who haven't configured plugins yet.
 *
 * Throws if the config file exists but can't be loaded (so
 * misconfiguration surfaces loudly rather than being silently
 * ignored).
 */
export async function loadPluginsFromConfig(startDir: string): Promise<readonly ApplierPlugin[]> {
  const configPath = findJsConfigFile(startDir);
  if (configPath == null) return [];

  // Dynamic import via `file://` URL so Node's ESM loader handles
  // .mjs / .js (with `"type": "module"`) and .cjs uniformly.
  const url = pathToFileURL(configPath).href;
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (e) {
    throw new Error(
      `[ts-capture] failed to load plugin config at ${configPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const config = extractConfigObject(mod);
  if (config == null) return [];
  const plugins = (config as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return [];

  // Light validation: each plugin must have the required shape so
  // a bad config produces a clear error, not a downstream
  // TypeError deep inside the apply loop.
  for (const p of plugins) {
    if (!isApplierPlugin(p)) {
      throw new Error(
        `[ts-capture] invalid plugin in ${configPath} — expected { name, match, resolveSourceFile, apply }, got: ${describePluginShape(p)}`,
      );
    }
  }
  return plugins;
}

function findJsConfigFile(startDir: string): string | undefined {
  const candidates = ["ts-capture.config.mjs", "ts-capture.config.js", "ts-capture.config.cjs"];
  let dir = path.resolve(startDir);
  while (true) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function extractConfigObject(mod: unknown): object | null {
  if (mod == null || typeof mod !== "object") return null;
  const m = mod as Record<string, unknown>;
  // ESM default export is at `.default`; CJS `module.exports = …` is at the top level.
  if (m.default && typeof m.default === "object") return m.default as object;
  return m;
}

function isApplierPlugin(value: unknown): value is ApplierPlugin {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.match === "function" &&
    typeof v.resolveSourceFile === "function" &&
    typeof v.apply === "function"
  );
}

function describePluginShape(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value !== "object") return typeof value;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).slice(0, 6).join(", ");
  return `object with keys [${keys}]`;
}
