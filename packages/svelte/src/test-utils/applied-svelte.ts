import { parse } from "svelte/compiler";

import { type Applied, checked } from "../../../core/src/test-utils/applied.js";

// Hold what an applier wrote into a .svelte file against the file it was
// given: each script block as the TypeScript it is, and everything around the
// blocks as text that must not have moved.

export interface AppliedSvelte {
  text: string;
  /** The instance `<script>` block, when the file has one. */
  script?: Applied;
  /** The `<script context="module">` block, when the file has one. */
  module?: Applied;
}

type Span = { start: number; end: number };
type Blocks = { script?: Span; module?: Span };

function blocksOf(source: string): Blocks {
  const ast = parse(source, { modern: true });
  const span = (block: { content: unknown } | null): Span | undefined =>
    block ? (block.content as Span) : undefined;
  return { script: span(ast.instance), module: span(ast.module) };
}

function around(source: string, blocks: Blocks): string {
  return [blocks.script, blocks.module]
    .filter((b): b is Span => b !== undefined)
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, { start, end }) => text.slice(0, start) + text.slice(end),
      source,
    );
}

export function appliedSvelte(
  input: string,
  text: string,
  options: { files?: Record<string, string> } = {},
): AppliedSvelte {
  const before = blocksOf(input);
  const after = blocksOf(text);
  if (around(input, before) !== around(text, after)) {
    throw new Error(
      `the applier changed the file outside its script blocks:\n${text}`,
    );
  }
  const held = (kind: "module" | "script"): Applied | undefined => {
    const from = before[kind];
    const to = after[kind];
    if (!from || !to) return undefined;
    return checked(
      input.slice(from.start, from.end),
      text.slice(to.start, to.end),
      { filename: `Comp.svelte__${kind}.ts`, files: options.files },
    );
  };
  return { text, script: held("script"), module: held("module") };
}
