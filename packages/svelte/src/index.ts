import type {
  ApplierPlugin,
  ApplyTypesOptions,
  CollectedTypeInfo,
  InstrumentOptions,
} from "@ts-capture/core";

import { instrumentSource } from "@ts-capture/core";

import { applySvelteTypesToFile } from "./apply.js";

export { applySvelteTypesToFile } from "./apply.js";
export type { ApplySvelteTypesOptions } from "./apply.js";

export interface SveltePreprocessorOptions extends InstrumentOptions {}

export type SvelteScriptHookInput = {
  content: string;
  attributes: Record<string, string | boolean>;
  filename?: string;
};

export type SvelteProcessed = { code: string };

export interface TsCaptureSveltePreprocessor {
  script(input: SvelteScriptHookInput): SvelteProcessed;
}

/**
 * Svelte 5 reserves the `$` prefix for runes ($state, $derived, $props,
 * $bindable, $effect, $inspect, $host — and their member forms like
 * $state.raw, $derived.by) and enforces that they appear as the DIRECT
 * right-hand side of a variable declaration or class field. Wrapping
 * them in __tscptr__.ret(...) breaks the placement rule:
 *
 *   "$derived(...) can only be used as a variable declaration initializer,
 *    a class field declaration, or the first assignment to a class field
 *    at the top level of the constructor."
 *
 * The check is permissive on purpose — any $-prefixed call is skipped,
 * not just the known rune names. Svelte 5 reserves the entire prefix
 * anyway, so any non-rune `$X()` in a .svelte block would already error.
 */
const isSvelteRuneCalleeName = (name: string): boolean => name.startsWith("$");

/**
 * Returns a Svelte preprocessor that instruments `<script lang="ts">` blocks
 * for runtime type observation. Pass to `svelte.preprocess()` before compilation.
 *
 * Blocks without `lang="ts"` (plain JS, including SvelteKit's generated
 * `root.svelte`) are passed through unchanged — instrumenting them would
 * inject TS-only `declare` statements into JS source and break the Svelte
 * compile step.
 *
 * Virtual filenames follow the pattern `<svelteFile>__script.ts` and
 * `<svelteFile>__module.ts` so `applySvelteTypesToFile` can route each
 * block's collected type-info back to the right offset.
 */
export function sveltePreprocessor(
  options?: SveltePreprocessorOptions,
): TsCaptureSveltePreprocessor {
  return {
    script({
      content,
      attributes,
      filename,
    }: SvelteScriptHookInput): SvelteProcessed {
      if (attributes.lang !== "ts") {
        return { code: content };
      }
      const isModule = attributes.context === "module";
      const suffix = isModule ? "__module" : "__script";
      const base = filename ?? "component.svelte";
      const virtualName = `${base}${suffix}.ts`;
      const instrumented = instrumentSource(content, virtualName, {
        ...options,
        // Svelte 5 runes must remain the direct RHS of varDecl/class-field.
        // Compose with any caller-provided predicate so options.skipInitializerCalleeWhen
        // still takes effect for non-rune call sites.
        skipInitializerCalleeWhen: (name) =>
          isSvelteRuneCalleeName(name) ||
          options?.skipInitializerCalleeWhen?.(name) === true,
      });
      return { code: instrumented };
    },
  };
}

/**
 * Applier-plugin that routes synthetic `*.svelte__script.ts`
 * / `*.svelte__module.ts` entries back to the owning `.svelte` file
 * via `applySvelteTypesToFile`. Register from a user's
 * `ts-capture.config.{mjs,js,cjs}`:
 *
 * ```js title="ts-capture.config.mjs"
 * import { sveltePlugin } from "@ts-capture/svelte";
 * export default { plugins: [sveltePlugin()] };
 * ```
 *
 * Without this plugin, the core CLI prints a stderr warning and
 * skips every synthetic svelte path (the earlier safety net).
 * With it registered, both `__script.ts` and `__module.ts`
 * virtual entries for the same `.svelte` file are routed to a
 * single `applySvelteTypesToFile` call that writes annotations
 * back into the owning file's `<script>` blocks.
 */
export function sveltePlugin(): ApplierPlugin {
  const VIRTUAL_SUFFIX_RE = /\.svelte__(?:script|module)\.ts$/;
  return {
    name: "svelte",
    match: (filePath: string): boolean => VIRTUAL_SUFFIX_RE.test(filePath),
    resolveSourceFile: (filePath: string): string =>
      filePath.replace(/__(?:script|module)\.ts$/, ""),
    apply: (
      source: string,
      entries: CollectedTypeInfo,
      options: ApplyTypesOptions,
    ): string => {
      // `options.filename` is the resolved `.svelte` path (the CLI
      // strips the virtual suffix via resolveSourceFile before
      // calling). applySvelteTypesToFile uses it to filter entries
      // back to the right script/module block by matching the
      // virtual prefix in each entry's filename.
      const svelteFilename = options.filename ?? "";
      return applySvelteTypesToFile(source, entries, {
        ...options,
        svelteFilename,
      });
    },
  };
}
