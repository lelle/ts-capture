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
export type ReverseImportGraph = Map<string, Set<string>>;

/**
 * The files in an order where each comes after the files it imports, so a
 * callee annotated earlier in the run is already typed when its callers are
 * judged. Files nothing here orders keep their given order, and so do the
 * members of an import cycle, after everything the cycle does not involve.
 */
export function orderByImports(
  files: readonly string[],
  importersOf: ReverseImportGraph,
  caseSensitive: boolean = ts.sys.useCaseSensitiveFileNames,
): string[] {
  const norm = (p: string): string => (caseSensitive ? p : p.toLowerCase());
  const indexOf = new Map(files.map((file, i) => [norm(file), i]));
  const waitingOn = files.map(() => 0);
  const importers: number[][] = files.map(() => []);
  files.forEach((file, i) => {
    for (const importer of importersOf.get(norm(file)) ?? []) {
      const j = indexOf.get(norm(importer));
      if (j === undefined || j === i) continue;
      importers[i].push(j);
      waitingOn[j]++;
    }
  });
  const ordered: string[] = [];
  const placed = new Set<number>();
  const ready = files.map((_, i) => i).filter((i) => waitingOn[i] === 0);
  while (ready.length > 0) {
    const i = ready.shift()!;
    ordered.push(files[i]);
    placed.add(i);
    for (const j of importers[i]) if (--waitingOn[j] === 0) ready.push(j);
  }
  files.forEach((file, i) => {
    if (!placed.has(i)) ordered.push(file);
  });
  return ordered;
}

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
  /** Where the project's files are read from: the disk, unless one was given. */
  system: ts.System;
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
  system: ts.System = ts.sys,
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
      const text = system.readFile(file);
      if (text === undefined) return undefined;
      const snap = ts.ScriptSnapshot.fromString(text);
      snapshots.set(file, snap);
      return snap;
    },
    getCurrentDirectory: () => rootDir,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (opts) => defaultLibFilePath(system, opts),
    fileExists: system.fileExists,
    readFile: system.readFile,
    readDirectory: system.readDirectory,
    directoryExists: system.directoryExists,
    getDirectories: system.getDirectories,
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
  const reverseImportGraph = buildReverseImportGraph(service, fileNames, system);

  return {
    service,
    host,
    userFiles: fileNames,
    baselineDiagnostics,
    reverseImportGraph,
    rootDir,
    system,
  };
}

/** `ts.getDefaultLibFilePath` reads the disk's system; this reads the one given. */
function defaultLibFilePath(system: ts.System, options: ts.CompilerOptions): string {
  if (system === ts.sys) return ts.getDefaultLibFilePath(options);
  const directory = system.getExecutingFilePath().replace(/[\\/][^\\/]*$/, "");
  return `${directory}/${ts.getDefaultLibFileName(options)}`;
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
  const importersOfTarget = findTransitiveImporters(
    project.reverseImportGraph,
    targetFile,
    project.system.useCaseSensitiveFileNames,
  );
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
  system: ts.System,
): ReverseImportGraph {
  const graph: ReverseImportGraph = new Map();
  const program = service.getProgram();
  if (!program) return graph;
  const compilerOptions = program.getCompilerOptions();
  const caseSensitive = system.useCaseSensitiveFileNames;
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
          system,
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
function findTransitiveImporters(
  graph: ReverseImportGraph,
  targetFile: string,
  caseSensitive: boolean,
): string[] {
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
    if (hasNewDiagnostic(service, ctx.filename, baselineDiagnostics, replacements)) {
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
  replacements?: ReadonlyArray<SpanReplacement>,
): boolean {
  return findNewDiagnostic(service, file, baseline, replacements) !== undefined;
}

function findNewDiagnostic(
  service: ts.LanguageService,
  file: string,
  baseline: Set<string>,
  replacements?: ReadonlyArray<SpanReplacement>,
): ts.Diagnostic | undefined {
  const isNew = (d: ts.Diagnostic): boolean => {
    if (!replacements || d.start === undefined) return !baseline.has(diagnosticIdentity(d));
    const start = sourceOffsetOfProbeOffset(d.start, replacements);
    return start === undefined || !baseline.has(diagnosticIdentity(d, start));
  };
  return (
    service.getSemanticDiagnostics(file).find(isNew) ??
    service.getSyntacticDiagnostics(file).find(isNew)
  );
}

/**
 * The first diagnostic one rejected candidate introduces on its own, for
 * reporting. Undefined when it is clean alone and was rejected only in
 * combination with others.
 */
export function explainRejection(
  ctx: VerificationContext,
  replacement: SpanReplacement,
  supportingFor?: SupportingReplacements,
): { code: number; message: string; file: string; line: number } | undefined {
  const { service, host, baselineDiagnostics } = ctx.project;
  const probe = withSupport([replacement], supportingFor);
  host.setFileSnapshot(ctx.filename, applyReplacementsForProbe(ctx.currentSource, probe));
  try {
    const found =
      findNewDiagnostic(service, ctx.filename, baselineDiagnostics, probe) ??
      ctx.importersOfTarget
        .map((file) => findNewDiagnostic(service, file, baselineDiagnostics))
        .find((d) => d !== undefined);
    if (!found) return undefined;
    const line =
      found.file && found.start !== undefined
        ? found.file.getLineAndCharacterOfPosition(found.start).line + 1
        : 0;
    return {
      code: found.code,
      message: ts.flattenDiagnosticMessageText(found.messageText, " "),
      file: found.file?.fileName ?? ctx.filename,
      line,
    };
  } finally {
    host.setFileSnapshot(ctx.filename, ctx.currentSource);
  }
}

/**
 * True when `candidate` annotates a variable whose initializer, with the
 * `accepted` annotations written, infers a type wider than the annotation:
 * TypeScript already has a type there that holds what the run saw.
 */
export function initializerInfersWider(
  ctx: VerificationContext,
  accepted: ReadonlyArray<SpanReplacement>,
  candidate: SpanReplacement,
  supportingFor?: SupportingReplacements,
): boolean {
  const { service, host } = ctx.project;
  const probe = withSupport([...accepted, candidate], supportingFor);
  host.setFileSnapshot(ctx.filename, applyReplacementsForProbe(ctx.currentSource, probe));
  try {
    const program = service.getProgram();
    const sf = program?.getSourceFile(ctx.filename);
    if (!program || !sf) return false;
    const checker = program.getTypeChecker();
    const declaration = findVariableDeclaration(
      sf,
      (d) => sourceOffsetOfProbeOffset(d.name.end, probe) === candidate.start,
    );
    if (!declaration?.type || !declaration.initializer) return false;
    const annotated = checker.getTypeFromTypeNode(declaration.type);
    const inferred = checker.getTypeAtLocation(declaration.initializer);
    if (inferred.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    return (
      checker.isTypeAssignableTo(annotated, inferred) &&
      !checker.isTypeAssignableTo(inferred, annotated)
    );
  } finally {
    host.setFileSnapshot(ctx.filename, ctx.currentSource);
  }
}

function findVariableDeclaration(
  node: ts.Node,
  matches: (declaration: ts.VariableDeclaration) => boolean,
): ts.VariableDeclaration | undefined {
  if (ts.isVariableDeclaration(node) && matches(node)) return node;
  return ts.forEachChild(node, (child) => findVariableDeclaration(child, matches));
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
 * cheaper than probing each candidate on its own.
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
  supportingFor?: SupportingReplacements,
): number[] {
  if (candidates.length === 0) return [];
  const introducesErrors = (subset: ReadonlyArray<SpanReplacement>): boolean =>
    wouldIntroduceErrors(ctx, withSupport(subset, supportingFor));
  if (!introducesErrors(candidates)) {
    return candidates.map((_, i) => i);
  }
  const bisected = bisectFilter(
    introducesErrors,
    candidates,
    candidates.map((_, i) => i),
  );
  // Combined-validity check — bisect's split-and-conquer can miss
  // candidate interactions (rare for independent insertions at
  // different offsets). If the bisected accepted set still fails
  // when combined, fall back to greedy.
  const bisectedReplacements = bisected.map((i) => candidates[i]);
  if (bisected.length === 0 || !introducesErrors(bisectedReplacements)) {
    return bisected;
  }
  return greedyFilter(introducesErrors, candidates);
}

/**
 * The replacements a set of candidates needs beside it to be judged: a type
 * declaration the candidates name, say. Asked per probe, because a declaration
 * nothing in the probe refers to is an unused local wherever `noUnusedLocals`
 * is on, and would fail every subset that does not happen to use it.
 */
export type SupportingReplacements = (
  subset: ReadonlyArray<SpanReplacement>,
) => ReadonlyArray<SpanReplacement>;

function withSupport(
  subset: ReadonlyArray<SpanReplacement>,
  supportingFor: SupportingReplacements | undefined,
): ReadonlyArray<SpanReplacement> {
  return supportingFor ? [...supportingFor(subset), ...subset] : subset;
}

function bisectFilter(
  introducesErrors: (subset: ReadonlyArray<SpanReplacement>) => boolean,
  candidates: ReadonlyArray<SpanReplacement>,
  indexes: readonly number[],
): number[] {
  if (indexes.length === 0) return [];
  const subset = indexes.map((i) => candidates[i]);
  if (!introducesErrors(subset)) return [...indexes];
  if (indexes.length === 1) return [];
  const mid = indexes.length >> 1;
  const left = bisectFilter(introducesErrors, candidates, indexes.slice(0, mid));
  const right = bisectFilter(introducesErrors, candidates, indexes.slice(mid));
  return [...left, ...right];
}

function greedyFilter(
  introducesErrors: (subset: ReadonlyArray<SpanReplacement>) => boolean,
  candidates: ReadonlyArray<SpanReplacement>,
): number[] {
  const accepted: number[] = [];
  const acceptedReplacements: Array<SpanReplacement> = [];
  for (let i = 0; i < candidates.length; i++) {
    const trial = [...acceptedReplacements, candidates[i]];
    if (!introducesErrors(trial)) {
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
 * source for the target file without the cross-file re-baseline. Used
 * when later verify probes must see the source as written so far. Skips the expensive cross-file
 * diagnostic scan — caller is responsible for ensuring the new source
 * doesn't introduce diagnostics that should re-baseline (typically by
 * having already filtered through `filterAcceptedReplacements`).
 *
 * The target file's own diagnostics are read again: a baseline identity
 * holds an offset, and an edit moves every diagnostic after it. The caller
 * has already established that the new text adds none, so what the file
 * reports now is the old set where it sits now.
 */
export function advanceCurrentSource(ctx: VerificationContext, newSource: string): void {
  if (ctx.currentSource === newSource) return;
  ctx.currentSource = newSource;
  const { service, host, baselineDiagnostics } = ctx.project;
  host.setFileSnapshot(ctx.filename, newSource);
  for (const d of service.getSemanticDiagnostics(ctx.filename)) {
    baselineDiagnostics.add(diagnosticIdentity(d));
  }
  for (const d of service.getSyntacticDiagnostics(ctx.filename)) {
    baselineDiagnostics.add(diagnosticIdentity(d));
  }
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

function diagnosticIdentity(d: ts.Diagnostic, start: number = d.start ?? -1): string {
  return `${d.file?.fileName ?? ""}:${start}:${d.code}`;
}

/**
 * Map a probe diagnostic offset back to baseline coordinates, so an insertion
 * does not give every diagnostic below it a new identity. `undefined` means the
 * offset lies inside inserted text, which is new by construction.
 */
function sourceOffsetOfProbeOffset(
  offset: number,
  replacements: ReadonlyArray<SpanReplacement>,
): number | undefined {
  let shift = 0;
  for (const r of [...replacements].sort((a, b) => a.start - b.start)) {
    const probeStart = r.start + shift;
    if (offset <= probeStart) return offset - shift;
    if (offset < probeStart + r.text.length) return undefined;
    shift += r.text.length - (r.end - r.start);
  }
  return offset - shift;
}
