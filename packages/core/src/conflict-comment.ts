import ts from "typescript";

// Notes ts-capture leaves where the run contradicts the project's own types.
//
// Every other output of apply is an annotation, checked by the TypeChecker and
// then by `tsc`. These are not: they are findings, addressed to a person. A
// position TypeScript infers as `string` where the code produced `undefined`
// during a real run is either a bug in the code or a wrong type, and which one
// it is cannot be decided from the observation — so apply reports it and leaves
// the code alone.
//
// Because nothing checks a comment, apply owns them completely: every run
// removes the notes it finds and writes the ones that hold now. See
// `markerLineRanges`.

/** The prefix every note carries. Anything on a line with it belongs to apply. */
export const CONFLICT_MARKER = "// @ts-capture:";

/** One contradiction, at one annotation site. */
export interface ConflictNote {
  /** What the site is called — `req`, `{ name, age }`, `getUrl return`. */
  name: string;
  /** Arms the run saw that the checker's type does not have. */
  observed: string[];
  /** What the checker infers at the site. */
  inferred: string;
}

/**
 * Parse for the text-run check, with the dialect the extension implies.
 *
 * The extension is not cosmetic here. Parsing a `.ts` file as TSX reads `<` as
 * the start of a JSX element, and a misparse invents JsxText spanning ordinary
 * code — which made the check refuse notes on lines that were never inside a
 * string. It cost one real note on nestjs/nest before it was caught.
 */
export function parseForNoteSafety(filename: string | undefined, source: string): ts.SourceFile {
  const jsx = filename !== undefined && /\.[jt]sx$/.test(filename);
  return ts.createSourceFile(
    jsx ? "__note_safety.tsx" : "__note_safety.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Does this position sit inside text that is not code?
 *
 * A note goes in at the start of the line it describes, and inside a
 * multi-line template literal that start is inside the string: the comment
 * becomes part of the text, and its backticks close the template early. JSX
 * children have the same shape — a comment there renders.
 *
 * The interpolations of a template are real code and take notes normally; only
 * the literal runs between them are unsafe.
 */
export function isInsideTextRun(sf: ts.SourceFile, pos: number): boolean {
  let inside = false;
  const isTextRun = (node: ts.Node): boolean =>
    ts.isJsxText(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isStringLiteral(node) ||
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail;

  const visit = (node: ts.Node): void => {
    if (inside) return;
    // `node.pos`, not `getStart`: the latter skips leading trivia, and for
    // JsxText the whitespace *is* the content — the node would look as though
    // it began after the line start being asked about.
    if (isTextRun(node) && node.pos <= pos && pos < node.end) {
      inside = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return inside;
}

/** Where the line holding `pos` begins, and the whitespace it opens with. */
export function lineStartAndIndent(
  source: string,
  pos: number,
): { lineStart: number; indent: string } {
  const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, pos));
  return { lineStart, indent: match ? match[0] : "" };
}

/**
 * The note block for one source line: one comment per conflict, in the order
 * given, which is source order — so the notes read left to right like the code
 * beneath them.
 */
export function conflictCommentText(notes: readonly ConflictNote[], indent: string): string {
  return notes
    .map(
      (n) =>
        `${indent}${CONFLICT_MARKER} \`${n.name}\` observed \`${n.observed.join(" | ")}\`, ` +
        `TypeScript infers \`${n.inferred}\`\n`,
    )
    .join("");
}

/** One suggestion, at one annotation site, for the preview mode. */
export interface PreviewNote {
  /** The annotation that would have been written. */
  suggestion: string;
  /** How many times the run saw a value here. */
  observations: number;
  /** What the checker infers, when a project made it askable. */
  inferred?: string;
}

/**
 * The preview block for one source line.
 *
 * What it says depends on whether the annotation is being written beside it.
 * Alone, the note has to name the type, because nothing else does. Next to the
 * annotation, naming it repeats the line below verbatim — a 156-character
 * union twice over — and "would write" claims something did not happen when it
 * did. What is left is what the annotation cannot say: how much the run saw,
 * and what TypeScript held before.
 *
 * The observation count is here and deliberately not in the eval's report. As
 * a machine gate it fails — a value seen once is as likely a config object read
 * at startup as one arbitrary caller's payload, and nothing in the count
 * separates those. A reader can separate them, by looking at where the value
 * comes from, and "observed once" is the signal worth that minute.
 */
export function previewCommentText(
  notes: readonly PreviewNote[],
  indent: string,
  mode: "comments" | "both" = "comments",
): string {
  return notes
    .map((n) => {
      const seen = n.observations === 1 ? "observed once" : `observed ${n.observations} times`;
      const known = n.inferred === undefined ? "" : `; TypeScript infers \`${n.inferred}\``;
      if (mode === "both") return `${indent}${CONFLICT_MARKER} ${seen}${known}\n`;
      // The marker on both lines, not just the first: removal matches the
      // marker, so a continuation line without it would be orphaned in the
      // file the moment the note it belongs to was rewritten.
      return (
        `${indent}${CONFLICT_MARKER} would write \`${n.suggestion}\`\n` +
        `${indent}${CONFLICT_MARKER}   ${seen}${known}\n`
      );
    })
    .join("");
}

/**
 * Ranges of every whole line that is one of apply's notes, newline included.
 *
 * Whole lines only. A marker-shaped comment trailing real code is not
 * something apply wrote, and removing it would take the code with it.
 */
export function markerLineRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let lineStart = 0;
  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    if (source.slice(lineStart, lineEnd).trimStart().startsWith(CONFLICT_MARKER)) {
      ranges.push([lineStart, newline === -1 ? lineEnd : newline + 1]);
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return ranges;
}

/**
 * What to call the site in the note.
 *
 * A note that does not say which position it means is a note the reader cannot
 * follow — and one line can hold several sites, so `(req, res) => …` needs the
 * name even when only one of them disagrees.
 */
export function siteName(
  kind: "param" | "varDecl" | "returnType",
  node: ts.Node,
  sf: ts.SourceFile,
): string {
  if (kind === "returnType") {
    const named = node as ts.SignatureDeclaration & { name?: ts.Node };
    return named.name ? `${named.name.getText(sf)} return` : "return";
  }
  const declaration = node as ts.ParameterDeclaration | ts.VariableDeclaration;
  return declaration.name.getText(sf);
}
