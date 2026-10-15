/**
 * Node.js loader hooks for ts-capture.
 *
 * Instruments TypeScript files as they are loaded. Node runs these hooks
 * on a thread of their own, so the runtime the instrumented code calls is
 * installed by `register.ts`, on the thread the program runs on.
 */

import type { LoadHook } from "node:module";

import path from "node:path";

import { findConfigFile, loadConfig, resolveInstrumentOptions } from "./config-file.js";
import { instrumentSource } from "./instrument.js";

const TS_EXTENSIONS = /\.(?:ts|tsx|mts|cts)$/;

// Discover config
const configPath = findConfigFile(process.cwd());
const config = configPath ? loadConfig(configPath) : {};
const instrumentOpts = resolveInstrumentOptions(
  config,
  configPath ? path.dirname(configPath) : undefined,
);

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
