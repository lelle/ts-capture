import ts from "typescript";

/**
 * ECMA-core allowlist of type names that ts-capture may emit even when
 * no explicit import / same-file decl brings them in. Mirrors what every
 * TS project's `lib.es*.d.ts` provides as ambient globals. DOM types and
 * other `lib.dom.d.ts` / `lib.es*.d.ts` types beyond this core list are
 * deliberately out-of-scope for the text-level path — those positions
 * get skipped (untyped). The TypeChecker-aware path picks them up.
 */
const ECMA_CORE_TYPES: ReadonlySet<string> = new Set([
  "Array",
  "ArrayBuffer",
  "BigInt",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "Function",
  "Map",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "Float32Array",
  "Float64Array",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "BigInt64Array",
  "BigUint64Array",
  "Generator",
  "AsyncGenerator",
  "Iterator",
  "AsyncIterator",
  "IterableIterator",
  "AsyncIterableIterator",
  "Iterable",
  "AsyncIterable",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
]);

/**
 * Collect type-reference names reachable as TYPES at the target file.
 * Includes imports (default, named, namespace name), same-file
 * `interface` / `type` / `class` / `enum` declarations, and the ECMA-core
 * allowlist. Misses re-exports past the import statement, DOM types, and
 * most `lib.dom.d.ts` / `lib.es*.d.ts` ambients beyond ECMA core — the
 * TypeChecker-aware path fills those gaps.
 *
 * When the target file is `.tsx` / `.jsx`, also includes `React` —
 * ts-capture emits `React.ReactElement` for observed React elements. The
 * `React` namespace is UMD-globally available via `@types/react`'s
 * `export as namespace React`, so the type resolves without an explicit
 * import. Without this scope addition, the no-Program path would reject
 * every annotation that references `React`, leaving React component
 * props untyped.
 */
export function buildScopedTypeNames(source: string, filename?: string): Set<string> {
  const names = new Set<string>(ECMA_CORE_TYPES);
  if (filename && /\.(?:tsx|jsx)$/i.test(filename)) {
    names.add("React");
  }
  const sf = ts.createSourceFile(
    "__ts-capture_scope.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const ic = stmt.importClause;
      if (ic.name) names.add(ic.name.text);
      const nb = ic.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb)) {
          names.add(nb.name.text);
        } else if (ts.isNamedImports(nb)) {
          for (const el of nb.elements) names.add(el.name.text);
        }
      }
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      if (stmt.name) names.add(stmt.name.text);
    }
  }
  return names;
}

/**
 * Extract PascalCase type identifiers from a ts-capture-emitted annotation
 * string. Regex-based — covers the type strings ts-capture emits in
 * practice (unions, arrays, generics, structural literals, intersections),
 * but is a heuristic. Negative lookbehind skips dotted property accesses
 * like `Foo.Bar` (we only want top-level identifiers, not qualified ones).
 */
function extractTypeRefs(emitted: string): string[] {
  const refs = new Set<string>();
  for (const m of emitted.matchAll(/(?<![.\w])([A-Z]\w*)/g)) {
    refs.add(m[1]);
  }
  return [...refs];
}

/**
 * Return `true` when every PascalCase ref in the emitted annotation is
 * reachable as a type at the target file. `false` means some name is
 * unreachable — skip the annotation (position stays untyped, same as
 * pre-instrument).
 */
export function allTypeRefsInScope(emitted: string, scopedNames: Set<string> | undefined): boolean {
  if (!scopedNames) return true;
  for (const ref of extractTypeRefs(emitted)) {
    if (!scopedNames.has(ref)) return false;
  }
  return true;
}

/**
 * TypeChecker-aware scope discovery. Uses
 * `ts.TypeChecker.getSymbolsInScope` scoped to the target file's
 * module-level position. Picks up: DOM types (HTMLElement, Document,
 * Window, Event, etc.) from lib.dom.d.ts, other lib.es*.d.ts ambients,
 * re-exported names whose import statement the text scan saw, and any
 * other type symbols the compiler recognises at the file level.
 *
 * Returns undefined when the program doesn't know about the file
 * (out-of-project, dynamic file, etc.) — caller should fall back to
 * the text-level check.
 *
 * Performance: getSymbolsInScope does lazy symbol resolution. First
 * call per file may be slow on large projects; subsequent calls within
 * the same Program are amortised. For typical apply runs (single
 * Program, many files), the total cost is dominated by Program
 * construction, not the per-file scope queries.
 */
export function buildScopedTypeNamesViaTypeChecker(
  program: ts.Program,
  filename: string,
): Set<string> | undefined {
  const sf = program.getSourceFile(filename);
  if (!sf) return undefined;
  const checker = program.getTypeChecker();
  // getSymbolsInScope at the SourceFile (module-level) with
  // `Type | Alias` returns: direct type symbols + import aliases
  // (which are resolved through to their underlying Type meaning).
  // Lights up imports, same-file decls, lib.dom + lib.es ambients,
  // and namespace roots.
  //
  // The Alias flag is critical for cross-file imports: an imported
  // name's symbol is initially an Alias, not a Type — `Type` alone
  // misses it. `Alias` instructs the checker to look through the
  // import to the underlying meaning.
  const flags = ts.SymbolFlags.Type | ts.SymbolFlags.Alias;
  const symbols = checker.getSymbolsInScope(sf, flags);
  const names = new Set<string>();
  for (const sym of symbols) names.add(sym.getName());
  return names;
}

/**
 * Build a map from class/interface/type-alias name → type-parameter arity
 * for every generic type symbol reachable from `filename`. `expandCtorArity`
 * consumes this to fill in `<unknown, ...>` for bare names that would
 * otherwise cause TS2314 ("Generic type 'X<T>' requires N type argument(s)").
 *
 * Only records entries with arity > 0. Returns `undefined` when the file
 * isn't in the Program (out-of-project, dynamic).
 */
export function buildCtorArityMap(
  program: ts.Program,
  filename: string,
): Map<string, number> | undefined {
  const sf = program.getSourceFile(filename);
  if (!sf) return undefined;
  const checker = program.getTypeChecker();
  const flags = ts.SymbolFlags.Type | ts.SymbolFlags.Alias;
  const symbols = checker.getSymbolsInScope(sf, flags);
  const arityMap = new Map<string, number>();
  for (const sym of symbols) {
    let resolved = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        resolved = checker.getAliasedSymbol(sym);
      } catch {
        continue;
      }
    }
    const decls = resolved.getDeclarations();
    if (!decls) continue;
    let maxArity = 0;
    for (const decl of decls) {
      if (
        ts.isClassDeclaration(decl) ||
        ts.isInterfaceDeclaration(decl) ||
        ts.isTypeAliasDeclaration(decl)
      ) {
        maxArity = Math.max(maxArity, decl.typeParameters?.length ?? 0);
      }
    }
    if (maxArity > 0) arityMap.set(sym.getName(), maxArity);
  }
  return arityMap;
}

/**
 * Expand bare generic type names in `typeStr` that appear in `arityMap`
 * with `<unknown, ...>` so they satisfy TS2314 ("Generic type 'X<T>'
 * requires N type argument(s)"). Names already followed by `<` are
 * left unchanged (no double-expansion). Only PascalCase identifiers are
 * matched (consistent with `extractTypeRefs`).
 */
export function expandCtorArity(typeStr: string, arityMap: Map<string, number>): string {
  return typeStr.replace(/(?<![.\w])([A-Z]\w*)(?![<\w])/g, (match, name: string) => {
    const arity = arityMap.get(name);
    if (!arity) return match;
    return `${name}<${Array(arity).fill("unknown").join(", ")}>`;
  });
}
