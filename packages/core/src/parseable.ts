import ts from "typescript";

/**
 * Defense-in-depth: verify a candidate type string is a syntactically
 * valid TypeScript type. Wraps it as the RHS of a
 * `let x: T = null as any;` declaration and parses with the TS
 * compiler in non-strict mode. Returns false when the parser reports
 * any diagnostics — apply then skips the site rather than writing a
 * type that wrecks the file (`(request: eObject: ...) => unknown`,
 * `(childrencompanySectorsdealCategories…Object: …) => unknown`,
 * etc.). The runtime stringifier doesn't produce these for the known
 * cases, but the guard remains as a backstop for future bugs in any
 * code path that constructs a type string.
 *
 * Exported so the CST applier (`apply-types-cst.ts`) shares the same
 * guard — both apply paths must refuse to write unparseable types.
 */
export function isParseableTypeString(typeText: string): boolean {
  const t = typeText.trim();
  if (t === "") return false;
  const wrapped = `let __ts_capture_apply_check__: ${t} = null as any;`;
  const sf = ts.createSourceFile(
    "__ts_capture_apply_check.ts",
    wrapped,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ts.ScriptKind.TS,
  );
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return !diags || diags.length === 0;
}
