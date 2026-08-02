import fs from "node:fs";
import path from "node:path";
import { type RawSourceMap, SourceMapConsumer } from "source-map";

import type { CollectedTypeInfo, ExtraOptions } from "../type-collector.js";
import type { BundleObservation } from "./instrument-bundle.js";

export interface TranslateBundleOptions {
  /**
   * Directory the source-map's `source` paths are resolved against.
   * Defaults to the directory containing the bundle file.
   */
  sourceRoot?: string;
}

export interface TranslateBundleResult {
  /** Observations successfully translated to source positions. */
  typeInfo: CollectedTypeInfo;
  /** Observations that could not be mapped (no source-map entry). */
  unmapped: BundleObservation[];
  /** Observations that mapped to a source path that doesn't exist on disk. */
  missingSource: BundleObservation[];
}

/**
 * Round-trip bundle observations through a source map back to original
 * `.ts` source positions, producing a CollectedTypeInfo that the regular
 * `ts-capture apply` step can consume.
 *
 * Two-phase mapping:
 *   1. byte offset in bundle → (line, column) in bundle
 *   2. source-map lookup → (originalSource, originalLine, originalColumn)
 *   3. (line, column) in source → byte offset in source
 *
 * Name recovery: minified bundles mangle parameter names (`name` → `r`),
 * but the source-map preserves position. We re-read the parameter name
 * FROM SOURCE at the round-tripped offset rather than trusting the
 * (possibly mangled) name from the bundle.
 */
export async function translateBundleObservations(
  observations: BundleObservation[],
  bundleSource: string,
  sourceMapJson: RawSourceMap,
  options: TranslateBundleOptions = {},
): Promise<TranslateBundleResult> {
  const consumer = await new SourceMapConsumer(sourceMapJson);
  try {
    return translate(observations, bundleSource, consumer, options);
  } finally {
    consumer.destroy();
  }
}

function translate(
  observations: BundleObservation[],
  bundleSource: string,
  consumer: SourceMapConsumer,
  options: TranslateBundleOptions,
): TranslateBundleResult {
  // Group by file so we can deduplicate observations at the same source
  // position and merge their observed types.
  const grouped = new Map<string, Map<number, { types: Set<string>; opts: ExtraOptions }>>();
  const unmapped: BundleObservation[] = [];
  const missingSource: BundleObservation[] = [];
  const sourceCache = new Map<string, string>();

  for (const obs of observations) {
    const bundleLC = offsetToLineCol(bundleSource, obs.pos);
    const orig = consumer.originalPositionFor(bundleLC);
    if (!orig.source) {
      unmapped.push(obs);
      continue;
    }
    const sourcePath = resolveSourcePath(orig.source, obs.file, options.sourceRoot);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      missingSource.push(obs);
      continue;
    }
    let sourceText = sourceCache.get(sourcePath);
    if (sourceText === undefined) {
      sourceText = fs.readFileSync(sourcePath, "utf-8");
      sourceCache.set(sourcePath, sourceText);
    }

    const sourceOffset = lineColToOffset(sourceText, orig.line ?? 1, orig.column ?? 0);
    if (sourceOffset < 0) {
      unmapped.push(obs);
      continue;
    }

    // Recover the parameter name from source — needed for minified
    // bundles where obs.name has been mangled.
    const id = sourceText.slice(sourceOffset).match(/^[a-zA-Z_$][\w$]*/);
    if (!id) {
      // Mapped position doesn't sit on an identifier — likely a webpack-
      // style line-only mapping. Skip rather than apply to whitespace.
      unmapped.push(obs);
      continue;
    }
    const recoveredName = id[0];
    // ts-capture apply inserts `: Type` AFTER the identifier. The position we
    // record must therefore be `sourceOffset + recoveredName.length`.
    const insertOffset = sourceOffset + recoveredName.length;

    let perFile = grouped.get(sourcePath);
    if (!perFile) {
      perFile = new Map();
      grouped.set(sourcePath, perFile);
    }
    let entry = perFile.get(insertOffset);
    if (!entry) {
      entry = { types: new Set(), opts: {} };
      perFile.set(insertOffset, entry);
    }
    entry.types.add(observedTypeToTypeName(obs.type));
  }

  // Build CollectedTypeInfo
  const typeInfo: CollectedTypeInfo = [];
  for (const [filePath, perFile] of grouped) {
    for (const [offset, { types, opts }] of perFile) {
      typeInfo.push([filePath, offset, [...types].map((t) => [t, undefined]), opts]);
    }
  }

  return { typeInfo, unmapped, missingSource };
}

function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

function lineColToOffset(text: string, line: number, column: number): number {
  let p = 0;
  for (let l = 1; l < line; l++) {
    p = text.indexOf("\n", p) + 1;
    if (p === 0) return -1;
  }
  return p + column;
}

function resolveSourcePath(
  mapSource: string,
  bundleFsPath: string,
  sourceRoot: string | undefined,
): string | null {
  // Strip URL schemes used by various bundlers (webpack:// etc.)
  let s = mapSource;
  const urlMatch = s.match(/^[a-z]+:\/\/[^/]*\/(.+)$/);
  if (urlMatch) s = urlMatch[1];
  if (path.isAbsolute(s)) return s;
  // Resolve relative to provided sourceRoot or bundle directory
  const base = sourceRoot ?? path.dirname(bundleFsPath);
  return path.resolve(base, s);
}

/**
 * Map the runtime-collector's coarse type names (`string`, `number`,
 * `array`, `User`, etc.) to the type-name format ts-capture apply consumes
 * (which expects strings like `string`, `number`, `unknown[]`, or class
 * names).
 */
function observedTypeToTypeName(observed: string): string {
  if (observed === "array") return "unknown[]";
  if (observed === "object") return "{}";
  return observed;
}
