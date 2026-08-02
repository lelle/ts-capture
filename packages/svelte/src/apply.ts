import type { ApplyTypesOptions, CollectedTypeInfo } from "@ts-capture/core";

import { applyTypesToFile, registerVirtualFile } from "@ts-capture/core";
import { parse } from "svelte/compiler";

import { registerRunesAmbient } from "./runes-ambient.js";
// Svelte's parser attaches character offsets to all AST nodes, but the estree
// `Program` type doesn't declare them. We only need start/end here.
type SvelteProgram = { start: number; end: number };

export interface ApplySvelteTypesOptions extends ApplyTypesOptions {
  /**
   * Path of the .svelte file being processed.
   * Must match the `filename` passed to `sveltePreprocessor().script()` so
   * virtual filenames (`<svelteFilename>__script.ts`) can be matched against
   * the collected type-info entries.
   */
  svelteFilename: string;
}

/**
 * Apply collected type observations back to a `.svelte` source file.
 *
 * Works by extracting each `<script>` block's text, applying
 * `applyTypesToFile` to the block in isolation (positions are relative to the
 * block content, matching what `sveltePreprocessor` produced), then splicing
 * the annotated block back into the full `.svelte` source.
 *
 * Blocks are processed in reverse source order so a splice to a later block
 * does not shift the start offset of an earlier block.
 */
export function applySvelteTypesToFile(
  svelteSource: string,
  typeInfo: CollectedTypeInfo,
  options: ApplySvelteTypesOptions,
): string {
  const ast = parse(svelteSource, { modern: true });

  type ScriptBlock = NonNullable<typeof ast.instance>;
  const blocks: ScriptBlock[] = (
    [ast.instance, ast.module] as (ScriptBlock | null)[]
  ).filter((b): b is ScriptBlock => b != null);

  if (blocks.length === 0) return svelteSource;

  const contentOf = (b: ScriptBlock): SvelteProgram =>
    b.content as unknown as SvelteProgram;

  // Descending by content start: later block processed first, so earlier offsets stay valid.
  blocks.sort((a, b) => contentOf(b).start - contentOf(a).start);

  let result = svelteSource;

  for (const block of blocks) {
    const isModule = block.context === "module";
    const suffix = isModule ? "__module" : "__script";
    const virtualPrefix = `${options.svelteFilename}${suffix}`;

    const blockEntries = typeInfo.filter(([fn]) =>
      fn.startsWith(virtualPrefix),
    );
    if (blockEntries.length === 0) continue;

    const { start, end } = contentOf(block);
    const scriptText = result.slice(start, end);

    // When the CLI hands over the project verification
    // context, verify each block as a standalone TS file co-located with
    // the .svelte source. The virtual path equals the entries' synthetic
    // path (`<svelteFile>__script.ts`), so it sits in the same directory
    // and resolves the same relative / path-alias imports. Block offsets
    // already match the virtual file's text (scriptText). Without a
    // project context the block applies heuristically as before.
    let applied: string;
    if (options.projectVerify) {
      const virtualPath = `${virtualPrefix}.ts`;
      registerRunesAmbient(options.projectVerify);
      const verify = registerVirtualFile(
        options.projectVerify,
        virtualPath,
        scriptText,
      );
      const program = options.projectVerify.service.getProgram();
      applied = applyTypesToFile(
        scriptText,
        blockEntries,
        { ...options, verify, filename: virtualPath },
        program,
      );
    } else {
      applied = applyTypesToFile(scriptText, blockEntries, options);
    }
    result = result.slice(0, start) + applied + result.slice(end);
  }

  return result;
}
