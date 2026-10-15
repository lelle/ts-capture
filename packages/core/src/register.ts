/**
 * Node.js register entry point for ts-capture.
 *
 * Usage:
 *   node --import @ts-capture/core/register src/main.ts
 *
 * This module:
 * 1. Registers a module loader hook that instruments .ts/.tsx files
 * 2. Sets up a global __tscptr__ collection context
 * 3. On process exit, applies collected types back to source files
 *
 * 2 and 3 happen here, not in the loader: the loader runs on its own thread,
 * and a global it sets is not one the program can see.
 */

import fs from "node:fs";
import { register } from "node:module";

import type { CollectionContext, ExtraOptions } from "./type-collector.js";

import { applyTypesToFile } from "./apply-types.js";
import { createCollectionContext, getTypeName } from "./type-collector.js";

// Collection context for this session
const ctx: CollectionContext = createCollectionContext();

// Set up global __tscptr__
const __tscptr__ = function (
  name: string,
  value: unknown,
  pos: number,
  filename: string,
  optsJson: string,
) {
  ctx.record(name, value, pos, filename, JSON.parse(optsJson) as ExtraOptions);
};
__tscptr__.track = function <T>(value: T, filename: string, offset: number): T {
  return ctx.track(value, filename, offset);
};
__tscptr__.ret = function <T>(value: T, pos: number, filename: string, optsJson: string): T {
  ctx.record("(return)", value, pos, filename, JSON.parse(optsJson) as ExtraOptions);
  return value;
};
__tscptr__.registerFn = function (fn: Function, retPos: number, filename: string) {
  ctx.registerFn(fn, retPos, filename);
};
__tscptr__.regFn = function <T extends Function>(fn: T, retPos: number, filename: string): T {
  ctx.registerFn(fn, retPos, filename);
  return fn;
};
__tscptr__.typeName = getTypeName;
__tscptr__.get = () => ctx.getCollectedTypes();

(globalThis as Record<string, unknown>).__tscptr__ = __tscptr__;

// Apply types on exit
process.on("exit", () => {
  const collected = ctx.getCollectedTypes();
  if (collected.length === 0) return;

  // Group by filename
  const grouped = new Map<string, typeof collected>();
  for (const entry of collected) {
    const file = entry[0];
    const existing = grouped.get(file);
    if (existing) existing.push(entry);
    else grouped.set(file, [entry]);
  }

  for (const [file, entries] of grouped) {
    try {
      const source = fs.readFileSync(file, "utf-8");
      const result = applyTypesToFile(source, entries, {});
      fs.writeFileSync(file, result);
    } catch {
      // Best-effort during exit
    }
  }
});

// `register` is flagged @deprecated by recent @types/node in favour of
// `module.registerHooks`, but we keep it deliberately: registerHooks needs
// Node >=22.15 (this package supports Node >=20) and runs hooks synchronously
// in-thread, whereas our `./loader.js` is an out-of-thread async ESM loader.
// Switching would drop the supported-Node floor and require rewriting the
// loader. Keep this rationale beside the deprecated call so it remains visible.
register("./loader.js", import.meta.url);
