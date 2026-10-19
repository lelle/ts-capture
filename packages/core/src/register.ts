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

import { annotateProject } from "./annotate.js";
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

// Returned promises wait in the context until they settle, and their value is
// read in a `.then`, which no longer runs once the process is exiting.
process.on("beforeExit", () => ctx.settlePromises());

// Apply types on exit
process.on("exit", () => {
  const collected = ctx.getCollectedTypes();
  if (collected.length === 0) return;

  const { files } = annotateProject({ types: collected, readFile: readSource });
  for (const [file, result] of files) {
    try {
      fs.writeFileSync(file, result.text);
    } catch {
      // Best-effort during exit
    }
  }
});

function readSource(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

// `register` is flagged @deprecated by recent @types/node in favour of
// `module.registerHooks`, but we keep it deliberately: registerHooks needs
// Node >=22.15 (this package supports Node >=20) and runs hooks synchronously
// in-thread, whereas our `./loader.js` is an out-of-thread async ESM loader.
// Switching would drop the supported-Node floor and require rewriting the
// loader. Keep this rationale beside the deprecated call so it remains visible.
register("./loader.js", import.meta.url);
