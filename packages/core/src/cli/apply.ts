import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { CollectedTypeInfo } from "../type-collector.js";

import { type ApplierPlugin, loadPluginsFromConfig, routeFile } from "../applier-plugin.js";
import { buildSkipMatcher } from "../apply-skip.js";
import { applyTypesToFileCst } from "../apply-types-cst.js";
import {
  advanceCurrentSource,
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
function resolveInferConfig(config: TsCaptureConfig, args: string[], flags: Set<string>) {
  const cliOverrides = parseInferFlagOverrides(args);
  // Shorthands for the mode most worth reaching for. `--infer.outputMode=` is
  // the option; these are a way to find it. The explicit form wins, so a flag
  // never becomes a second source of truth.
  const shorthand = flags.has("--comments") ? "comments" : flags.has("--both") ? "both" : undefined;
  if (shorthand && cliOverrides.outputMode === undefined) cliOverrides.outputMode = shorthand;
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
// Flags `apply` acts on. Unknown ones still run — a script sending a flag a
// newer version understands should not stop — but `apply` rewrites source
// files, and the flags that hold it back are exactly the ones a typo turns
// off. `--comment` is not `--comments`, and the difference is a preview
// against a rewrite. `--infer.*` is parsed separately and not listed here.
const APPLY_FLAGS = [
  "--dry-run",
  "--comments",
  "--both",
  "--include-tests",
  "--force",
  "--telemetry",
  "--project",
];

/** The known flag a mistyped one is nearest to, when it is near enough to name. */
function nearestFlag(given: string): string | undefined {
  return APPLY_FLAGS.find((known) => known.startsWith(given) || given.startsWith(known));
}

function warnUnrecognisedFlags(flags: Set<string>): void {
  for (const flag of flags) {
    if (APPLY_FLAGS.includes(flag) || flag.startsWith("--infer.")) continue;
    const near = nearestFlag(flag);
    process.stderr.write(
      `[ts-capture apply] unrecognised flag: ${flag}` +
        (near ? ` — did you mean ${near}?` : "") +
        `\n[ts-capture apply] apply rewrites source files; it is running without it.\n`,
    );
  }
}

export async function cmdApply(args: string[], flags: Set<string>) {
  // Same spelling as `verify --project`. Read before the positional, so the
  // path it carries is not mistaken for the types.json.
  const projectArg =
    args.find((a) => a.startsWith("--project="))?.slice("--project=".length) ??
    (args.includes("--project") ? args[args.indexOf("--project") + 1] : undefined);
  const jsonPath = args.find((a) => !a.startsWith("-") && a !== "apply" && a !== projectArg);
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
  let infer = resolveInferConfig(config, args, flags);

  warnUnrecognisedFlags(flags);
  const dryRun = flags.has("--dry-run");
  const includeTests = flags.has("--include-tests");
  const force = flags.has("--force");
  const telemetryEnabled = flags.has("--telemetry");
  // Always counted, printed only on request. `emitted` is what decides whether
  // the manifest is written, and a counter is cheaper than the alternative:
  // asking each applier afterwards what it did.
  const telemetry: ApplyTelemetry = newApplyTelemetry();

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
  const tsConfigPath = projectArg ? path.resolve(projectArg) : findTsConfigUpward(process.cwd());
  if (projectArg && !fs.existsSync(tsConfigPath!)) {
    process.stderr.write(`Error: --project not found: ${tsConfigPath}\n`);
    process.exit(1);
  }
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

  // A solution-style config — `files: []` with `references` — is the standard
  // shape for a TypeScript monorepo, and upward discovery finds it. It builds
  // a Program with nothing in it, and every checker-backed rule then turns off
  // at once: the redundancy oracle, the five suppression rules, the
  // contradiction check. Apply keeps going on its syntactic guards alone,
  // which is a defensible fallback but a terrible thing to do in silence — on
  // honojs/hono it took the same observations from 88 annotations to 1078 and
  // broke a build that compiled before.
  //
  // Which referenced project to use is not apply's to guess: they carry
  // different compilerOptions, and answering from the wrong one is worse than
  // not answering. So it names the problem and the flag that settles it.
  if (tsConfigPath && program && program.getRootFileNames().length === 0) {
    process.stderr.write(
      `[ts-capture apply] ${tsConfigPath} holds no files — every check that needs a project is off, ` +
        `and apply is running on its syntactic guards alone. ` +
        `If this is a solution-style config, name the project that covers these sources: ` +
        `--project <tsconfig.json>.\n`,
    );
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

    // Tell the shared LanguageService what this file now says, so later
    // files verify against the project as it actually is rather than
    // against every earlier file's original text. Without this, an
    // annotation that is only wrong in combination with an earlier file's
    // annotation is never seen — six such errors survived a run on
    // nestjs/nest with `typecheckVerify` on.
    //
    // `advanceCurrentSource`, not `commitReplacements`: the cheap variant
    // swaps the in-memory source without the project-wide re-baseline. The
    // re-baseline would absorb exactly the cross-file regressions we want
    // to catch, and costs a full diagnostic scan per applied file.
    //
    // `--dry-run` advances too. Nothing here touches disk, and a preview
    // that judged every file against the project's starting state would
    // list files the real run then rejects at verify.
    if (verify) {
      advanceCurrentSource(verify, result);
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
    //
    // Only when an annotation was actually written. A preview writes the file
    // but annotates nothing, so it is neither a dry run nor an apply, and the
    // manifest had no third case: it claimed the types.json was applied and
    // closed the one workflow the mode exists for — read the proposals, then
    // take them. The same holds for a real apply every one of whose candidates
    // was suppressed: there is nothing for a second pass to short-circuit, and
    // saying otherwise is the same untruth.
    if (telemetry.emitted === 0) return;

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

  if (telemetryEnabled) printTelemetrySummary(telemetry);
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
