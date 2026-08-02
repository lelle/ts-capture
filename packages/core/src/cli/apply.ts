import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { CollectedTypeInfo } from "../type-collector.js";

import { type ApplierPlugin, loadPluginsFromConfig, routeFile } from "../applier-plugin.js";
import { buildSkipMatcher } from "../apply-skip.js";
import { applyTypesToFileCst } from "../apply-types-cst.js";
import {
  createProjectVerificationContext,
  createVerificationContext,
} from "../apply-types-verify.js";
import { applyTypesToFile } from "../apply-types.js";
import { getProgram } from "../compiler-helper.js";
import {
  findConfigFile,
  loadConfig,
  parseInferFlagOverrides,
  resolveInferOptions,
  type TsCaptureConfig,
} from "../configuration.js";
import { type ApplyTelemetry, newApplyTelemetry } from "../contract.js";

interface ApplyManifest {
  version: 1;
  typeInfoHash: string;
  appliedAt: string;
}

/**
 * Auto-discover the nearest tsconfig.json by walking up from a starting
 * directory. Mirrors how eslint / prettier / vitest find their project
 * config — most natural UX for `ts-capture apply` which is typically
 * run from the project root. Returns undefined if no tsconfig is found
 * by the filesystem root, in which case the apply pipeline falls back
 * to the text-level scope check.
 */
function findTsConfigUpward(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Hash the contents of types.json. The manifest sidecar uses this to
 * detect "this exact types.json has already been applied" — sha256 is
 * cryptographic-strength but cheap. The "sha256:" prefix is so future
 * algorithm migrations are obvious.
 */
function hashTypeInfoContent(jsonContent: string): string {
  return "sha256:" + crypto.createHash("sha256").update(jsonContent).digest("hex");
}

/**
 * Build the resolved InferOptions for a CLI invocation: load ts-capture.config.json
 * if it exists, deep-merge --infer.X.Y=value overrides on top, return the
 * fully resolved InferOptions object.
 */
function resolveInferConfig(config: TsCaptureConfig, args: string[]) {
  const cliOverrides = parseInferFlagOverrides(args);
  const merged: TsCaptureConfig = {
    ...config,
    infer: { ...config.infer, ...cliOverrides },
  };
  // Manual deep-merge for the nested objects (literal, patternDetection,
  // narrowOptional) since spread is shallow.
  if (config.infer || Object.keys(cliOverrides).length > 0) {
    const cfgI = config.infer ?? {};
    merged.infer = {
      ...cfgI,
      ...cliOverrides,
      literal: { ...cfgI.literal, ...cliOverrides.literal },
      patternDetection: {
        ...cfgI.patternDetection,
        ...cliOverrides.patternDetection,
      },
      narrowOptional: {
        ...cfgI.narrowOptional,
        ...cliOverrides.narrowOptional,
      },
    };
  }
  return resolveInferOptions(merged);
}

/** `ts-capture apply <types.json> [--dry-run] [--include-tests] [--force] [--telemetry]`. */
export async function cmdApply(args: string[], flags: Set<string>) {
  const jsonPath = args.find((a) => !a.startsWith("-") && a !== "apply");
  if (!jsonPath) {
    process.stderr.write("Error: missing types.json argument\n");
    process.exit(1);
  }

  const resolved = path.resolve(jsonPath);
  const jsonContent = fs.readFileSync(resolved, "utf-8");
  const typeInfo = JSON.parse(jsonContent) as CollectedTypeInfo;

  // Load ts-capture.config.json from cwd upward once; reuse for both
  // inference options and the apply-level skip-file globs. configDir is
  // the anchor for relative glob matching (gitignore-style).
  const configPath = findConfigFile(process.cwd());
  const config: TsCaptureConfig = configPath ? loadConfig(configPath) : {};
  const configDir = configPath ? path.dirname(configPath) : process.cwd();

  // Resolve inference options: config + any --infer.X.Y=value CLI overrides.
  let infer = resolveInferConfig(config, args);

  const dryRun = flags.has("--dry-run");
  const includeTests = flags.has("--include-tests");
  const force = flags.has("--force");
  const telemetryEnabled = flags.has("--telemetry");
  const telemetry: ApplyTelemetry | undefined = telemetryEnabled ? newApplyTelemetry() : undefined;

  // Idempotency manifest: <types.json>.applied. Covers the
  // multi-entry case (the in-source pos-based check in applyTypesToFile
  // covers single-entry; this covers full-file). On match:
  // short-circuit. --force bypasses; --dry-run never writes the
  // manifest.
  const manifestPath = resolved + ".applied";
  const currentHash = hashTypeInfoContent(jsonContent);
  if (!force && !dryRun && fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ApplyManifest;
      if (manifest.version === 1 && manifest.typeInfoHash === currentHash) {
        process.stdout.write(
          `apply: this types.json was already applied (manifest ${manifestPath}). Use --force to re-apply.\n`,
        );
        return;
      }
    } catch {
      // Malformed manifest — ignore and re-apply, write a fresh one.
    }
  }

  // Dispatch through applier plugins. The user's
  // `ts-capture.config.{mjs,js,cjs}` can register plugins
  // (e.g. `sveltePlugin()` from @ts-capture/svelte) that own
  // file paths the built-in applier doesn't know how to handle —
  // most importantly synthetic virtual paths a preprocessor emits
  // for blocks inside a host file (`*.svelte__script.ts` and the
  // like), which have no on-disk counterpart.
  //
  // Without a plugin configured, those virtual paths fall through
  // to the safety-net warning below (the earlier behaviour).
  const plugins = await loadPluginsFromConfig(process.cwd());

  // Group entries by the RESOLVED on-disk source file (after
  // plugin routing). Each group records which plugin owns it
  // (null = built-in applier). Multiple virtual paths can route
  // to the same source — e.g. `Foo.svelte__script.ts` and
  // `Foo.svelte__module.ts` both resolve to `Foo.svelte`.
  type Group = { entries: CollectedTypeInfo; plugin: ApplierPlugin | null };
  const grouped = new Map<string, Group>();
  const skippedVirtualFiles = new Set<string>();
  for (const entry of typeInfo) {
    const file = entry[0];
    const routing = routeFile(file, plugins);

    // Safety-net: an entry that no plugin claims AND that has no
    // on-disk file is a synthetic/virtual path (e.g. a preprocessor
    // block module) with nothing for the built-in applier to read.
    // Skip it with the warning below instead of crashing on the
    // missing-file open. Framework-agnostic by design — keyed on
    // on-disk absence, not on any one adapter's naming convention.
    if (routing.plugin === null && !fs.existsSync(file)) {
      skippedVirtualFiles.add(file);
      continue;
    }

    const existing = grouped.get(routing.sourceFile);
    if (existing) {
      existing.entries.push(entry);
    } else {
      grouped.set(routing.sourceFile, { entries: [entry], plugin: routing.plugin });
    }
  }

  if (skippedVirtualFiles.size > 0) {
    process.stderr.write(
      `[ts-capture apply] Skipping ${skippedVirtualFiles.size} virtual path(s) — not present on disk and not claimed by any applier plugin. These come from a preprocessor (e.g. @ts-capture/svelte emits \`*.svelte__script.ts\` for .svelte blocks); register the matching plugin in ts-capture.config.mjs (e.g. \`plugins: [sveltePlugin()]\`) to write annotations back into the host file.\n`,
    );
    for (const f of skippedVirtualFiles) {
      process.stderr.write(`  - ${f}\n`);
    }
  }

  // Auto-discover tsconfig.json from cwd upward. When found, build a
  // ts.Program lazily and pass it through to the applier so the
  // TypeChecker-aware scope check can resolve DOM types, namespace
  // members, and re-exports. When no tsconfig is found (CLI run from a
  // non-project dir), the appliers fall back to the text-level scope
  // check.
  const tsConfigPath = findTsConfigUpward(process.cwd());
  let program: ts.Program | undefined;
  // Parsed tsconfig kept around when typecheckVerify is on — verify
  // needs fileNames + compilerOptions to build a LanguageService per file.
  let parsedTsConfig: ts.ParsedCommandLine | undefined;
  if (tsConfigPath) {
    try {
      program = getProgram({
        tsConfig: tsConfigPath,
        rootDir: path.dirname(tsConfigPath),
      });
      if (infer.typecheckVerify) {
        const raw = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
        if (!raw.error && raw.config) {
          parsedTsConfig = ts.parseJsonConfigFileContent(
            raw.config,
            ts.sys,
            path.dirname(tsConfigPath),
          );
        }
      }
    } catch (e) {
      process.stderr.write(
        `[ts-capture apply] tsconfig discovery failed at ${tsConfigPath}: ${e instanceof Error ? e.message : String(e)} — falling back to text-level scope check.\n`,
      );
    }
  }

  if (infer.typecheckVerify && !parsedTsConfig) {
    process.stderr.write(
      `[ts-capture apply] --infer.typecheckVerify requires a discoverable tsconfig.json. Falling back to heuristic-only.\n`,
    );
    infer = { ...infer, typecheckVerify: false };
  }

  if (infer.ignoreExistingTypes) {
    process.stderr.write(
      `[ts-capture apply] --infer.ignoreExistingTypes is ON. This mode bypasses idempotency checks and emits annotations at already-typed positions; the resulting source IS NOT VALID TYPESCRIPT. Use it for divergence measurement only.\n`,
    );
  }

  const wouldChange: string[] = [];
  const noChange: string[] = [];
  const skippedFiles: string[] = [];

  // Gitignore-style skip chain: built-in test-file default (unless
  // --include-tests) + user `apply.skipFiles` globs from config.
  const skipMatcher = buildSkipMatcher(config.apply?.skipFiles, {
    includeTests,
    baseDir: configDir,
  });

  // Build the LanguageService + project baseline
  // ONCE, share across all file-level verification contexts. Per-file
  // we just swap the target snapshot.
  const projectVerifier =
    infer.typecheckVerify && parsedTsConfig
      ? createProjectVerificationContext(
          parsedTsConfig.fileNames,
          parsedTsConfig.options,
          path.dirname(tsConfigPath!),
        )
      : undefined;

  for (const [file, group] of grouped) {
    if (skipMatcher.shouldSkip(file)) {
      skippedFiles.push(file);
      continue;
    }

    const source = fs.readFileSync(file, "utf-8");
    // Verify only fires when the target file is part of the discovered
    // tsconfig's project. Files outside (e.g. ad-hoc test fixtures in
    // /tmp without their own tsconfig, or plugin-owned framework files
    // like `.svelte` that aren't in tsconfig's fileNames) fall back to
    // the heuristic path — the LanguageService can't supply diagnostics
    // for files it doesn't know about, so the verify probe would
    // silently reject every candidate.
    const verify =
      projectVerifier && projectVerifier.userFiles.includes(file)
        ? createVerificationContext(projectVerifier, file, source)
        : undefined;

    let result: string;
    if (group.plugin) {
      // Plugin-owned file: hand the resolved source + collected entries
      // to the plugin. Entries still carry their original virtual paths
      // so the plugin can route them to the right block / region inside
      // the source. Plugins don't currently honor telemetry — that's a
      // follow-up if/when plugin-side observability is needed.
      result = group.plugin.apply(source, group.entries, {
        infer,
        filename: file,
        verify,
        // Plugins verify their own framework blocks by registering
        // virtual TS files into the shared project context. Per-file
        // `verify` is undefined for .svelte (not in tsconfig), so hand
        // over the project context for the plugin to build block-level
        // verification.
        projectVerify: projectVerifier,
      });
    } else {
      const apply = infer.cstAware ? applyTypesToFileCst : applyTypesToFile;
      result = apply(source, group.entries, { infer, filename: file, verify, telemetry }, program);
    }

    if (result === source) {
      noChange.push(file);
      continue;
    }

    if (dryRun) {
      wouldChange.push(file);
    } else {
      fs.writeFileSync(file, result);
    }
  }

  if (dryRun) {
    if (wouldChange.length === 0) {
      process.stdout.write(`apply --dry-run: no changes would be made\n`);
    } else {
      process.stdout.write(`apply --dry-run: would modify ${wouldChange.length} file(s):\n`);
      for (const f of wouldChange) process.stdout.write(`  - ${f}\n`);
      if (noChange.length > 0) {
        process.stdout.write(`  (${noChange.length} file(s) already up-to-date)\n`);
      }
    }
    if (skippedFiles.length > 0) {
      process.stdout.write(
        `  (${skippedFiles.length} file(s) skipped by skip rules — use --include-tests for the test default, or adjust apply.skipFiles)\n`,
      );
    }
  } else {
    // Real (non-dry-run) apply: write the manifest so subsequent runs
    // with the same types.json short-circuit. Skip on --force so users
    // can repeatedly re-apply without leaving stale manifests.
    const manifest: ApplyManifest = {
      version: 1,
      typeInfoHash: currentHash,
      appliedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    } catch {
      // Best-effort. If the dir is read-only, idempotency degrades to
      // the in-source pos-check (still useful), but we don't fail the
      // apply over a manifest write.
    }
  }

  if (telemetry) printTelemetrySummary(telemetry);
}

function printTelemetrySummary(t: ApplyTelemetry): void {
  const total = t.totalEntries;
  const skipped = t.idempotent + t.unparseable + t.positionMismatch + t.verifyReject;
  const other = Math.max(0, total - t.emitted - skipped);
  const pct = total > 0 ? ((t.emitted / total) * 100).toFixed(1) : "0.0";
  process.stderr.write(`apply telemetry: ${t.emitted} of ${total} entries emitted (${pct} %).\n`);
  if (total === 0) return;
  process.stderr.write(`Skipped (${total - t.emitted}):\n`);
  if (t.idempotent > 0) {
    process.stderr.write(`  Idempotent (already typed): ${t.idempotent}\n`);
  }
  if (t.verifyReject > 0) {
    process.stderr.write(`  Verify oracle reject:       ${t.verifyReject}\n`);
  }
  if (t.positionMismatch > 0) {
    process.stderr.write(`  Position mismatch:          ${t.positionMismatch}\n`);
  }
  if (t.unparseable > 0) {
    process.stderr.write(`  Unparseable type string:    ${t.unparseable}\n`);
  }
  if (other > 0) {
    process.stderr.write(`  Other (heuristic skip):     ${other}\n`);
  }
}
