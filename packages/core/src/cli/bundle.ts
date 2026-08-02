import fs from "node:fs";
import path from "node:path";

import type { BundleObservation } from "../bundle/instrument-bundle.js";
import type { CollectedTypeInfo } from "../type-collector.js";

import { applyTypesToFile } from "../apply-types.js";
import { instrumentBundle } from "../bundle/instrument-bundle.js";
import { translateBundleObservations } from "../bundle/translate-observations.js";

/** `ts-capture instrument-bundle <bundle.js> [--out <path>]` — instrument a bundled JS artefact (the bundle-observation flow). */
export function cmdInstrumentBundle(args: string[]) {
  const positional = args.filter((a) => !a.startsWith("-") && a !== "instrument-bundle");
  const bundlePath = positional[0];
  if (!bundlePath) {
    process.stderr.write("Error: missing <bundle.js> argument\n");
    process.exit(1);
  }
  const outIdx = args.indexOf("--out");
  const outArg =
    outIdx >= 0
      ? args[outIdx + 1]
      : args.find((a) => a.startsWith("--out="))?.slice("--out=".length);

  const resolved = path.resolve(bundlePath);
  const source = fs.readFileSync(resolved, "utf-8");
  const result = instrumentBundle(source, resolved);
  const outPath = outArg ? path.resolve(outArg) : resolved.replace(/\.js$/, ".instrumented.js");
  fs.writeFileSync(outPath, result.code);
  process.stdout.write(
    `instrument-bundle: ${result.instrumentedCount} function bodies instrumented -> ${outPath}\n`,
  );
}

/**
 * `ts-capture apply-bundle <observations.json> --map <bundle.js.map> [--bundle <bundle.js>]`
 * — translate bundle observations back to source positions via the source map
 * and apply the resulting types.
 */
export async function cmdApplyBundle(args: string[]) {
  const positional = args.filter((a) => !a.startsWith("-") && a !== "apply-bundle");
  const obsPath = positional[0];
  if (!obsPath) {
    process.stderr.write("Error: missing <observations.json> argument\n");
    process.exit(1);
  }
  const mapIdx = args.indexOf("--map");
  const mapArg =
    mapIdx >= 0
      ? args[mapIdx + 1]
      : args.find((a) => a.startsWith("--map="))?.slice("--map=".length);
  if (!mapArg) {
    process.stderr.write("Error: --map <bundle.js.map> required\n");
    process.exit(1);
  }
  const bundleIdx = args.indexOf("--bundle");
  const bundleArg =
    bundleIdx >= 0
      ? args[bundleIdx + 1]
      : args.find((a) => a.startsWith("--bundle="))?.slice("--bundle=".length);

  const obsResolved = path.resolve(obsPath);
  const mapResolved = path.resolve(mapArg);

  const observations = JSON.parse(fs.readFileSync(obsResolved, "utf-8")) as BundleObservation[];
  const sourceMapJson = JSON.parse(fs.readFileSync(mapResolved, "utf-8"));

  // Determine bundle file path: explicit --bundle wins, else strip .map
  const bundlePath = bundleArg ? path.resolve(bundleArg) : mapResolved.replace(/\.map$/, "");
  const bundleSource = fs.readFileSync(bundlePath, "utf-8");

  const result = await translateBundleObservations(observations, bundleSource, sourceMapJson, {
    sourceRoot: path.dirname(bundlePath),
  });
  process.stdout.write(
    `apply-bundle: ${observations.length} observations -> ${result.typeInfo.length} translated, ${result.unmapped.length} unmapped, ${result.missingSource.length} missing-source\n`,
  );

  // Group by file and apply via existing applyTypesToFile.
  const grouped = new Map<string, CollectedTypeInfo>();
  for (const entry of result.typeInfo) {
    const file = entry[0];
    const existing = grouped.get(file);
    if (existing) existing.push(entry);
    else grouped.set(file, [entry]);
  }
  for (const [file, entries] of grouped) {
    const source = fs.readFileSync(file, "utf-8");
    const updated = applyTypesToFile(source, entries, {});
    fs.writeFileSync(file, updated);
  }
  process.stdout.write(`apply-bundle: applied to ${grouped.size} files\n`);
}
