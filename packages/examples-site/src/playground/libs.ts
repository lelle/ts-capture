import { createDefaultMapFromNodeModules } from "@typescript/vfs";
import ts from "typescript";

import { COMPILER_OPTIONS } from "./run.js";

const REFERENCE = /^\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/gm;

/** The lib files `roots` need: themselves and everything they reference. */
export function reachableLibs(
  all: ReadonlyMap<string, string>,
  roots: readonly string[],
): Map<string, string> {
  const kept = new Map<string, string>();
  const waiting = [...roots];
  while (waiting.length > 0) {
    const file = waiting.pop()!;
    if (kept.has(file)) continue;
    const text = all.get(file);
    if (text === undefined) throw new Error(`lib file not found: ${file}`);
    kept.set(file, text);
    for (const match of text.matchAll(REFERENCE))
      waiting.push(`/lib.${match[1]}.d.ts`);
  }
  return kept;
}

/** The lib files the playground's compiler options need, read from node_modules. */
export function playgroundLibs(): Map<string, string> {
  return reachableLibs(
    createDefaultMapFromNodeModules(COMPILER_OPTIONS, ts),
    (COMPILER_OPTIONS.lib ?? []).map((lib) => `/${lib}`),
  );
}
