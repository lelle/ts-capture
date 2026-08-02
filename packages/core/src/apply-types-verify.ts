/**
 * TypeChecker-in-the-loop verification. Lets apply ask
 * the TypeScript compiler "would this annotation introduce errors?"
 * directly, instead of approximating via accumulated heuristics.
 *
 * Build a `ts.LanguageService` once for a project, use it to:
 *   1. Snapshot the baseline diagnostics for the target file.
 *   2. Apply a candidate annotation in-memory, ask for diagnostics
 *      again, compare to baseline.
 *   3. Accept if no new diagnostic appears in the target file (or
 *      downstream files that depend on it).
 *
 * Strict scope for slice 1: per-candidate verification, in-memory
 * source updates via a custom `LanguageServiceHost`. Performance
 * mitigations (batch + bisect on failure) are slice-2+ work.
 */

import ts from "typescript";

type SpanReplacement = { start: number; end: number; text: string };
type ReverseImportGraph = Map<string, Set<string>>;

/**
 * Project-scoped verification state. Built once per `cmdApply` run
 * and shared across all per-file verification contexts. Holds the
 * heavyweight pieces: the `LanguageService` and its underlying host,
 * and the baseline diagnostic identities across the whole project.
 */
export interface ProjectVerificationContext {
  service: ts.LanguageService;
  host: MutableLanguageServiceHost;
  userFiles: readonly string[];
  /**
   * Baseline diagnostic identities (file:start:code) across every
   * user source file in the project. A new diagnostic appearing in
   * any of these files after applying a candidate counts as
   * "introduced errors". Mutated by `commitReplacements` so later
   * files in the same run don't see earlier accepted changes as
   * regressions.
   */
  baselineDiagnostics: Set<string>;
  /**
   * Reverse-import graph keyed by imported file. For any file X,
   * `reverseImportGraph.get(X)` is the set of files that import X via a
   * static `import` / `export` declaration. Built once at project
   * creation; cheaper than re-walking every file's imports per target.
   * Used to compute the transitive importer set for a verification
   * target — re-exports through index files / barrel files require
   * following the graph more than one hop.
   */
  reverseImportGraph: ReverseImportGraph;
  /**
   * Project root (the tsconfig directory). Synthetic virtual files
   * (— .svelte script blocks, the runes ambient) are placed here
   * so relative + path-alias imports resolve the same way the real
   * framework file's would.
   */
  rootDir: string;
}

export interface VerificationContext {
  project: ProjectVerificationContext;
  filename: string;
  /** Current in-memory source for the target file. Updated as candidates land. */
  currentSource: string;
  /**
   * Files that transitively import from the target file (directly
   * OR through any chain of re-exports). Per-probe cross-file scans
   * visit only `[target, ...importersOfTarget]` instead of every
   * user file. The direct-importer scope
   * missed diagnostics surfacing past a re-export boundary
   * (`providers/types.ts` re-exporting `CrmDataProvider`, consumer
   * importing from `providers/types`).
   */
  importersOfTarget: readonly string[];
}

/**
 * Mutable host so we can swap a file's snapshot without rebuilding
 * the entire compilation graph. The version bump tells the
 * LanguageService to re-check.
 */
interface MutableLanguageServiceHost extends ts.LanguageServiceHost {
  setFileSnapshot(file: string, text: string): void;
  /** Append a file to the program's root set (idempotent). */
  addRootFile(file: string): void;
}

/**
 * Build the project-scoped verification state once per CLI run.
 * Heavyweight — creates a `ts.LanguageService` and computes the
 * baseline diagnostic identities across every user file.
 */
export function createProjectVerificationContext(
  fileNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
  rootDir: string,
): ProjectVerificationContext {
  const versions = new Map<string, number>();
  const snapshots = new Map<string, ts.IScriptSnapshot>();
  for (const file of fileNames) versions.set(file, 1);
  // Mutable program root set. Starts as the project's files; synthetic
  // virtual files (e.g. .svelte script blocks) are appended
  // lazily via addRootFile so they become part of the compilation.
  const rootFiles: string[] = [...fileNames];

  const host: MutableLanguageServiceHost = {
    getScriptFileNames: () => rootFiles,
    getScriptVersion: (file) => String(versions.get(file) ?? 1),
    getScriptSnapshot: (file) => {
      const cached = snapshots.get(file);
      if (cached) return cached;
      const text = ts.sys.readFile(file);
      if (text === undefined) return undefined;
      const snap = ts.ScriptSnapshot.fromString(text);
      snapshots.set(file, snap);
      return snap;
    },
    getCurrentDirectory: () => rootDir,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    setFileSnapshot(file, text) {
      snapshots.set(file, ts.ScriptSnapshot.fromString(text));
      versions.set(file, (versions.get(file) ?? 1) + 1);
    },
    addRootFile(file) {
      if (!rootFiles.includes(file)) rootFiles.push(file);
    },
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const baselineDiagnostics = collectCrossFileDiagnostics(service, fileNames);
  const reverseImportGraph = buildReverseImportGraph(service, fileNames);

  return { service, host, userFiles: fileNames, baselineDiagnostics, reverseImportGraph, rootDir };
}

/**
 * Register an in-memory virtual TS file into an existing
 * project verification context and return a per-file verification
 * context for it.
 *
 * Used by applier plugins (e.g. `@ts-capture/svelte`) to verify a
 * framework block — extracted as standalone TS — against the real
 * project type-checker. `virtualPath` MUST be co-located with the real
 * framework file (same directory) so relative + tsconfig-path imports
 * resolve identically; `virtualSource` is the block text, with the same
 * offsets the collected entries use.
 *
 * The file's resting diagnostics are merged into the project baseline so
 * only diagnostics newly introduced by a candidate annotation are
 * treated as regressions. A virtual block is a leaf (nothing imports it),
 * so `importersOfTarget` is empty.
 */
export function registerVirtualFile(
  project: ProjectVerificationContext,
  virtualPath: string,
  virtualSource: string,
): VerificationContext {
  project.host.addRootFile(virtualPath);
  project.host.setFileSnapshot(virtualPath, virtualSource);
  const resting = collectCrossFileDiagnostics(project.service, [virtualPath]);
  for (const id of resting) project.baselineDiagnostics.add(id);
  return {
    project,
    filename: virtualPath,
    currentSource: virtualSource,
    importersOfTarget: [],
  };
}

/**
 * Steady-state performance: re-applying to an already-annotated file is
 * much cheaper than the first apply. The CST applier short-circuits on
 * `node.type !== undefined` (AST-native idempotency) BEFORE buffering a
 * candidate, so with nothing buffered no `filterAcceptedReplacements`
 * verify probes run and the per-file cost collapses to parse +
 * scope-index. First-run wall-clock — dominated by the LanguageService
 * build, the baseline diagnostic scan, and per-candidate verify probes —
 * remains the bottleneck for any future default-on flip.
 */

/**
 * Build a per-file verification context backed by a shared
 * project context. Lightweight — just records which file is the
 * current target and pre-computes its transitive importer set
 *.
 */
export function createVerificationContext(
  project: ProjectVerificationContext,
  targetFile: string,
  targetSource: string,
): VerificationContext {
  // Ensure the host's snapshot reflects the in-memory source.
  project.host.setFileSnapshot(targetFile, targetSource);
  const importersOfTarget = findTransitiveImporters(project.reverseImportGraph, targetFile);
  return {
    project,
    filename: targetFile,
    currentSource: targetSource,
    importersOfTarget,
  };
}

/**
 * Walk every static `import` / `export … from '…'` declaration in
 * the project and build a reverse-import graph: imported-file →
 * files that import it directly. Dynamic imports (`await
 * import(…)`) are intentionally skipped — they're rare in the apply
 * target set and the consumer would need separate inference to
 * resolve the specifier anyway.
 */
function buildReverseImportGraph(
  service: ts.LanguageService,
  fileNames: readonly string[],
): ReverseImportGraph {
  const graph: ReverseImportGraph = new Map();
  const program = service.getProgram();
  if (!program) return graph;
  const compilerOptions = program.getCompilerOptions();
  const caseSensitive = ts.sys.useCaseSensitiveFileNames;
  const norm = (p: string): string => (caseSensitive ? p : p.toLowerCase());

  for (const file of fileNames) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    for (const stmt of sf.statements) {
      if (
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const resolved = ts.resolveModuleName(
          stmt.moduleSpecifier.text,
          file,
          compilerOptions,
          ts.sys,
        ).resolvedModule;
        if (!resolved) continue;
        const importedNormalized = norm(resolved.resolvedFileName);
        let importers = graph.get(importedNormalized);
        if (!importers) {
          importers = new Set();
          graph.set(importedNormalized, importers);
        }
        importers.add(file);
      }
    }
  }
  return graph;
}

/**
 * BFS through the reverse-import graph to collect every file that
 * transitively imports the target. Cycles are handled by the
 * visited set. Excludes the target itself; the caller scans the
 * target separately as part of `wouldIntroduceErrors`'s early-exit
 * path.
 */
function findTransitiveImporters(graph: ReverseImportGraph, targetFile: string): string[] {
  const caseSensitive = ts.sys.useCaseSensitiveFileNames;
  const norm = (p: string): string => (caseSensitive ? p : p.toLowerCase());
  const targetNormalized = norm(targetFile);

  const visited = new Set<string>([targetNormalized]);
  const frontier: string[] = [targetNormalized];
  const result: string[] = [];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    const importers = graph.get(current);
    if (!importers) continue;
    for (const importer of importers) {
      const normImporter = norm(importer);
      if (visited.has(normImporter)) continue;
      visited.add(normImporter);
      result.push(importer);
      frontier.push(normImporter);
    }
  }
  return result;
}

/**
 * Returns true when applying the given replacements (insertions /
 * replacements at offsets in the original source) would introduce
 * at least one diagnostic in the target file that was not present
 * in the baseline. Does NOT mutate the context — strictly a probe.
 *
 * The implementation applies the replacements to a fresh source
 * string, swaps the host's snapshot, queries diagnostics, then
 * restores the previous snapshot. The version bump on swap+restore
 * makes the LanguageService re-check both times; the registry-based
 * caching keeps the cost amortized across many probes.
 */
export function wouldIntroduceErrors(
  ctx: VerificationContext,
  replacements: ReadonlyArray<SpanReplacement>,
): boolean {
  const { service, host, baselineDiagnostics } = ctx.project;
  const probeSource = applyReplacementsForProbe(ctx.currentSource, replacements);
  host.setFileSnapshot(ctx.filename, probeSource);
  try {
    // Scan the target file first and exit early if any new diagnostic
    // surfaces there. Most failure modes produce target-file
    // diagnostics; only the cross-file regressions need the broader
    // scan. Saves the (project-size − 1) per-file diagnostic calls in
    // the common case.
    if (hasNewDiagnostic(service, ctx.filename, baselineDiagnostics)) {
      return true;
    }
    // Per-probe cross-file scan limited to files that directly import
    // the target. Catches the discriminated-union-narrowing pattern
    // (ActivityLogIterator etc.) without paying the cost of scanning
    // every file in the project on each probe.
    for (const file of ctx.importersOfTarget) {
      if (hasNewDiagnostic(service, file, baselineDiagnostics)) {
        return true;
      }
    }
    return false;
  } finally {
    host.setFileSnapshot(ctx.filename, ctx.currentSource);
  }
}

function hasNewDiagnostic(
  service: ts.LanguageService,
  file: string,
  baseline: Set<string>,
): boolean {
  const semantic = service.getSemanticDiagnostics(file);
  for (const d of semantic) {
    if (!baseline.has(diagnosticIdentity(d))) return true;
  }
  const syntactic = service.getSyntacticDiagnostics(file);
  for (const d of syntactic) {
    if (!baseline.has(diagnosticIdentity(d))) return true;
  }
  return false;
}

/**
 * Persist a set of accepted replacements into the context so future
 * `wouldIntroduceErrors` probes layer on top of them. The new
 * baseline diagnostics are also re-snapshotted — any errors apply
 * has already accepted no longer count as "new" for subsequent
 * probes.
 */
/**
 * Batch verification with bisect-on-failure.
 *
 * Fast path: try every candidate together in one probe. If clean,
 * all are accepted with a single LanguageService scan — usually 30×
 * cheaper than the per-candidate slow path used by `applyTypesToFile`
 * before this slice.
 *
 * Slow path (batch is dirty): bisect — split the candidate set in
 * half and recurse. Subsets that pass alone are accepted; subsets
 * that fail are split further until each fails on its own. Then a
 * combined-validity check catches any rare candidate-interaction
 * that the per-subset probes missed, falling back to a final
 * greedy filter if needed. Worst-case probes are O(k log n) plus a
 * fallback O(n); independent insertions almost never hit the
 * fallback in practice.
 *
 * Returns the indexes (into the input array) of accepted candidates.
 */
export function filterAcceptedReplacements(
  ctx: VerificationContext,
  candidates: ReadonlyArray<SpanReplacement>,
): number[] {
  if (candidates.length === 0) return [];
  if (!wouldIntroduceErrors(ctx, candidates)) {
    return candidates.map((_, i) => i);
  }
  const bisected = bisectFilter(
    ctx,
    candidates,
    candidates.map((_, i) => i),
  );
  // Combined-validity check — bisect's split-and-conquer can miss
  // candidate interactions (rare for independent insertions at
  // different offsets). If the bisected accepted set still fails
  // when combined, fall back to greedy.
  const bisectedReplacements = bisected.map((i) => candidates[i]);
  if (bisected.length === 0 || !wouldIntroduceErrors(ctx, bisectedReplacements)) {
    return bisected;
  }
  return greedyFilter(ctx, candidates);
}

function bisectFilter(
  ctx: VerificationContext,
  candidates: ReadonlyArray<SpanReplacement>,
  indexes: readonly number[],
): number[] {
  if (indexes.length === 0) return [];
  const subset = indexes.map((i) => candidates[i]);
  if (!wouldIntroduceErrors(ctx, subset)) return [...indexes];
  if (indexes.length === 1) return [];
  const mid = indexes.length >> 1;
  const left = bisectFilter(ctx, candidates, indexes.slice(0, mid));
  const right = bisectFilter(ctx, candidates, indexes.slice(mid));
  return [...left, ...right];
}

function greedyFilter(
  ctx: VerificationContext,
  candidates: ReadonlyArray<SpanReplacement>,
): number[] {
  const accepted: number[] = [];
  const acceptedReplacements: Array<SpanReplacement> = [];
  for (let i = 0; i < candidates.length; i++) {
    const trial = [...acceptedReplacements, candidates[i]];
    if (!wouldIntroduceErrors(ctx, trial)) {
      accepted.push(i);
      acceptedReplacements.push(candidates[i]);
    }
  }
  return accepted;
}

export function commitReplacements(
  ctx: VerificationContext,
  replacements: ReadonlyArray<SpanReplacement>,
): void {
  const { service, host, baselineDiagnostics, userFiles } = ctx.project;
  ctx.currentSource = applyReplacementsForProbe(ctx.currentSource, replacements);
  host.setFileSnapshot(ctx.filename, ctx.currentSource);
  // Re-baseline so later files in the same run treat the just-
  // committed changes as part of the project's resting state, not
  // new regressions.
  const newDiagnostics = collectCrossFileDiagnostics(service, userFiles);
  for (const id of newDiagnostics) {
    baselineDiagnostics.add(id);
  }
}

/**
 * Lightweight variant of `commitReplacements`: swap the in-memory
 * source for the target file without re-baselining diagnostics. Used
 * when a multi-phase applier (e.g. CST → offset-based pass-through)
 * needs subsequent verify probes to see the same source string the
 * pass-through is editing into. Skips the expensive cross-file
 * diagnostic scan — caller is responsible for ensuring the new source
 * doesn't introduce diagnostics that should re-baseline (typically by
 * having already filtered through `filterAcceptedReplacements`).
 */
export function advanceCurrentSource(ctx: VerificationContext, newSource: string): void {
  if (ctx.currentSource === newSource) return;
  ctx.currentSource = newSource;
  ctx.project.host.setFileSnapshot(ctx.filename, newSource);
}

// --- internals ---

function applyReplacementsForProbe(
  source: string,
  replacements: ReadonlyArray<SpanReplacement>,
): string {
  // Right-to-left so earlier offsets don't shift when later edits land.
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let out = source;
  for (const r of sorted) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}

/**
 * Collect diagnostic identities across every user source file in the
 * project — necessary so cross-file regressions (annotation in file
 * A breaks a consumer in file B) surface as "introduced errors".
 */
function collectCrossFileDiagnostics(
  service: ts.LanguageService,
  files: readonly string[],
): Set<string> {
  const set = new Set<string>();
  for (const file of files) {
    const semantic = service.getSemanticDiagnostics(file);
    for (const d of semantic) {
      set.add(diagnosticIdentity(d));
    }
    const syntactic = service.getSyntacticDiagnostics(file);
    for (const d of syntactic) {
      set.add(diagnosticIdentity(d));
    }
  }
  return set;
}

function diagnosticIdentity(d: ts.Diagnostic): string {
  return `${d.file?.fileName ?? ""}:${d.start ?? -1}:${d.code}`;
}
