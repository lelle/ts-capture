/**
 * Node.js loader hooks for ts-capture.
 *
 * Instruments TypeScript files as they are loaded, enabling runtime
 * type collection. Works with Node 22+ module loader API.
 */

import type { LoadHook } from "node:module";

import fs from "node:fs";
import path from "node:path";

import type { CollectionContext, ExtraOptions } from "./type-collector.js";

import { applyTypesToFile } from "./apply-types.js";
import { findConfigFile, loadConfig, resolveInstrumentOptions } from "./configuration.js";
import { instrumentSource } from "./instrument.js";
import { createCollectionContext, getTypeName } from "./type-collector.js";

const TS_EXTENSIONS = /\.(?:ts|tsx|mts|cts)$/;

// Collection context for this session
const ctx: CollectionContext = createCollectionContext();

// Discover config
const configPath = findConfigFile(process.cwd());
const config = configPath ? loadConfig(configPath) : {};
const instrumentOpts = resolveInstrumentOptions(
  config,
  configPath ? path.dirname(configPath) : undefined,
);

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

// Loader hook: instrument .ts files
export const load: LoadHook = async (url, context, nextLoad) => {
  const result = await nextLoad(url, context);

  if (TS_EXTENSIONS.test(url) && result.source) {
    const source =
      typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
    const filePath = new URL(url).pathname;
    const instrumented = instrumentSource(source, filePath, instrumentOpts);
    return { ...result, source: instrumented };
  }

  return result;
};
