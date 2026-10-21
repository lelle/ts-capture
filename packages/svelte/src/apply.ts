import type {
  AnnotateResult,
  ApplyTypesOptions,
  CollectedTypeInfo,
  TypeOracle,
} from "@ts-capture/core";

import { annotate } from "@ts-capture/core";
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
 * Works by extracting each `<script>` block's text, annotating the block in
 * isolation (positions are relative to the block content, matching what
 * `sveltePreprocessor` produced), then splicing the annotated block back into
 * the full `.svelte` source.
 */
export function applySvelteTypesToFile(
  svelteSource: string,
  typeInfo: CollectedTypeInfo,
  options: ApplySvelteTypesOptions,
): string {
  return annotateSvelte(svelteSource, typeInfo, options).text;
}

/** As `applySvelteTypesToFile`, with skips at their positions in `svelteSource`. */
export function annotateSvelte(
  svelteSource: string,
  typeInfo: CollectedTypeInfo,
  options: ApplySvelteTypesOptions,
): AnnotateResult {
  // The blocks are annotated under virtual names; a pattern names the component.
  if (options.ignoreFiles?.some((p) => p.test(options.svelteFilename))) {
    return { text: svelteSource, skips: [], telemetry: emptyTelemetry() };
  }
  const ast = parse(svelteSource, { modern: true });

  type ScriptBlock = NonNullable<typeof ast.instance>;
  const blocks: ScriptBlock[] = (
    [ast.instance, ast.module] as (ScriptBlock | null)[]
  ).filter((b): b is ScriptBlock => b != null);

  const contentOf = (b: ScriptBlock): SvelteProgram =>
    b.content as unknown as SvelteProgram;

  // Descending by content start: a later block is spliced first, so an
  // earlier block's offsets, and every skip's, stay those of `svelteSource`.
  blocks.sort((a, b) => contentOf(b).start - contentOf(a).start);

  let text = svelteSource;
  const skips: AnnotateResult["skips"][number][] = [];
  const telemetry = emptyTelemetry();

  for (const block of blocks) {
    const isModule = block.context === "module";
    const suffix = isModule ? "__module" : "__script";
    const virtualPrefix = `${options.svelteFilename}${suffix}`;

    const blockEntries = typeInfo.filter(([fn]) =>
      fn.startsWith(virtualPrefix),
    );
    if (blockEntries.length === 0) continue;

    const { start, end } = contentOf(block);
    const scriptText = text.slice(start, end);

    // With the project context, the block is checked as a TS file next to the
    // component (`<svelteFile>__script.ts`), so it resolves the same relative
    // and path-alias imports.
    let oracle: TypeOracle = { kind: "none" };
    if (options.projectVerify) {
      registerRunesAmbient(options.projectVerify);
      oracle = { kind: "project", project: options.projectVerify };
    }
    const annotated = annotate(scriptText, blockEntries, {
      filename: `${virtualPrefix}.ts`,
      infer: options.infer,
      oracle,
      ignoreFiles: options.ignoreFiles,
    });
    text = text.slice(0, start) + annotated.text + text.slice(end);
    for (const skip of annotated.skips)
      skips.push({ ...skip, pos: skip.pos + start });
    addCounts(telemetry, annotated.telemetry);
  }

  telemetry.skipped = skips;
  return { text, skips, telemetry };
}

function emptyTelemetry(): AnnotateResult["telemetry"] {
  return {
    totalEntries: 0,
    emitted: 0,
    idempotent: 0,
    unparseable: 0,
    positionMismatch: 0,
    verifyReject: 0,
    redundant: 0,
    skipped: [],
  };
}

function addCounts(
  into: AnnotateResult["telemetry"],
  from: AnnotateResult["telemetry"],
): void {
  into.totalEntries += from.totalEntries;
  into.emitted += from.emitted;
  into.idempotent += from.idempotent;
  into.unparseable += from.unparseable;
  into.positionMismatch += from.positionMismatch;
  into.verifyReject += from.verifyReject;
  into.redundant += from.redundant;
}
