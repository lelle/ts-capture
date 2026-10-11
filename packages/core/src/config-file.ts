import fs from "node:fs";
import path from "node:path";

import type { CompilerOptions } from "./compiler-helper.js";
import type { TsCaptureConfig } from "./configuration.js";
import type { ApplyTypesOptions } from "./contract.js";
import type { InstrumentOptions } from "./transformer.js";

export function findConfigFile(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, "ts-capture.config.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfig(configPath: string): TsCaptureConfig {
  const resolved = path.resolve(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf-8");
  } catch {
    throw new Error(`Cannot read config file: ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${resolved}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Config file must be a JSON object: ${resolved}`);
  }

  return parsed as TsCaptureConfig;
}

export function resolveInstrumentOptions(
  config: TsCaptureConfig,
  configDir?: string,
): InstrumentOptions {
  const common = resolveCompilerOptions(config, configDir);
  return { ...common, ...config.instrument };
}

export function resolveApplyTypesOptions(
  config: TsCaptureConfig,
  configDir?: string,
): ApplyTypesOptions {
  const common = resolveCompilerOptions(config, configDir);
  return { ...common, ...config.applyTypes };
}

function resolveCompilerOptions(config: TsCaptureConfig, configDir?: string): CompilerOptions {
  const opts: CompilerOptions = { ...config.common };
  if (configDir) {
    if (opts.rootDir) opts.rootDir = path.resolve(configDir, opts.rootDir);
    if (opts.tsConfig) opts.tsConfig = path.resolve(configDir, opts.tsConfig);
  }
  return opts;
}
