import ts from "typescript";

import { Replacement } from "./replacement.js";

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

/** The prefix every note carries. Anything carrying it belongs to apply. */
export const CONFLICT_MARKER = "// @ts-capture";

/**
 * What the note is telling you, in a word.
 *
 * Reading a diff, the `+` on the code line says whether an annotation was
 * written. Reading the file it is gone, and the signal becomes an annotation
 * that is *missing* — which is not something a reader spots. It also makes the
 * findings greppable: on nestjs/nest 10 notes of 135 are the ones to act on,
 * and separating them otherwise means matching on wording.
 */
export type NoteState =
  | "conflict" // the run saw what the type forbids; nothing was written
  | "proposal" // what an annotation would have been; nothing was written
  | "applied"; // what was written, and why

const line = (state: NoteState): string => `${CONFLICT_MARKER}[${state}]:`;

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
        `${indent}${line("conflict")} \`${n.name}\` observed \`${n.observed.join(" | ")}\`, ` +
        `TypeScript infers \`${n.inferred}\`\n`,
    )
    .join("");
}

/** One suggestion, at one annotation site, for the preview mode. */
export interface PreviewNote {
  /** What the site is called — `req`, `{ name, age }`, `getUrl return`. */
  name: string;
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
 * Every note names its position, because one line can hold several sites:
 * `const a = (s) => (d) => (e) => e;` has three, and unnamed notes above it are
 * indistinguishable — beside the annotation they were literally identical.
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
      if (mode === "both") return `${indent}${line("applied")} \`${n.name}\` ${seen}${known}\n`;
      // The marker on both lines, not just the first: removal matches the
      // marker, so a continuation line without it would be orphaned in the
      // file the moment the note it belongs to was rewritten.
      // The tag sits on the first line only; the continuation carries the bare
      // marker, which is enough for removal and quieter to read.
      return (
        `${indent}${line("proposal")} \`${n.name}\` would be \`${n.suggestion}\`\n` +
        `${indent}${CONFLICT_MARKER}:   ${seen}${known}\n`
      );
    })
    .join("");
}

/** The marker as it reads inside a block comment. */
const INLINE_MARKER = "/* @ts-capture";
const inline = (state: NoteState): string => `${INLINE_MARKER}[${state}]:`;

/** A whole-line note, tagged or bare — but never `@ts-capture-ignore`. */
const NOTE_LINE_RE = /^\/\/ @ts-capture(?:\[[a-z]+\])?:/;
/** An inline note, tagged or bare. */
const NOTE_SPAN_RE = /\/\* @ts-capture(?:\[[a-z]+\])?:/g;

/**
 * A note that sits at the site instead of above it.
 *
 * Used where one line holds several sites. A leading note has to name its
 * position, and no name survives the hard case: `const a = (d) => (d) => (d)
 * => null;` has four positions with one name between them, and a qualifier
 * taken from the source is unbounded — a parameter list can be longer than the
 * type it introduces. At the site there is nothing to name, because the
 * position is the identifier.
 */
/** A note with the position it belongs to. */
type Placed<T> = T & { pos: number };

/** Notes for one line, and the indentation the line opens with. */
export interface NoteBucket<T> {
  indent: string;
  notes: Array<Placed<T>>;
}

/**
 * Where every note goes, as replacements.
 *
 * One place because both appliers need the same answer. It lived in the CST
 * applier alone, so a pass-through entry on a crowded line came out in the old
 * ambiguous form — invisible until a project routes through the second path,
 * and nestjs/nest does not.
 *
 * A line is crowded by every note it carries, contradictions included: left
 * out of the count they put two formats on one line, and kept a naming
 * collision that `(d) => (d)` produces on its own.
 */
export function noteReplacements(args: {
  conflictNotes: Map<number, NoteBucket<ConflictNote>>;
  previewNotes: Map<number, NoteBucket<PreviewNote>>;
  outputMode: "annotations" | "comments" | "both";
  /** False where a leading line would land inside a string or JSX text. */
  canPlaceNoteAt: (lineStart: number) => boolean;
}): Replacement[] {
  const { conflictNotes, previewNotes, outputMode, canPlaceNoteAt } = args;
  const mode = outputMode === "both" ? "both" : "comments";
  const out: Replacement[] = [];

  for (const lineStart of new Set([...conflictNotes.keys(), ...previewNotes.keys()])) {
    const conflicts = conflictNotes.get(lineStart);
    const previews = outputMode === "annotations" ? undefined : previewNotes.get(lineStart);
    const total = (conflicts?.notes.length ?? 0) + (previews?.notes.length ?? 0);
    if (total === 0) continue;

    if (total > 1) {
      // Priority below every annotation's: at one position the insert applied
      // first ends up rightmost, so the note lands after the type.
      //
      // No `canPlaceNoteAt` here — at a site the note sits where the
      // annotation would, which is code by definition.
      for (const note of conflicts?.notes ?? []) {
        out.push(Replacement.insert(note.pos, ` ${inlineConflictText(note)}`, -10));
      }
      for (const note of previews?.notes ?? []) {
        out.push(Replacement.insert(note.pos, ` ${inlineNoteText(note, mode)}`, -10));
      }
      continue;
    }

    if (!canPlaceNoteAt(lineStart)) continue;
    if (conflicts) {
      out.push(
        Replacement.insert(lineStart, conflictCommentText(conflicts.notes, conflicts.indent), -2),
      );
    } else if (previews) {
      out.push(
        Replacement.insert(
          lineStart,
          previewCommentText(previews.notes, previews.indent, mode),
          -3,
        ),
      );
    }
  }
  return out;
}

/**
 * A contradiction, written at the site rather than above the line.
 *
 * Internal to `noteReplacements`, which is the one place that decides between
 * the two placements — asserted through it rather than directly.
 */
function inlineConflictText(note: ConflictNote): string {
  return (
    `${inline("conflict")} observed \`${note.observed.join(" | ")}\`, ` +
    `TypeScript infers \`${note.inferred}\` */`
  );
}

export function inlineNoteText(note: PreviewNote, mode: "comments" | "both"): string {
  const seen = note.observations === 1 ? "observed once" : `observed ${note.observations} times`;
  const known = note.inferred === undefined ? "" : `; TypeScript infers \`${note.inferred}\``;
  const what = mode === "both" ? "" : `would be \`${note.suggestion}\`; `;
  return `${inline(mode === "both" ? "applied" : "proposal")} ${what}${seen}${known} */`;
}

/**
 * Ranges of every inline note, with the space that precedes it.
 *
 * A block comment delimits itself, so removal takes exactly the note and
 * nothing of the code around it — which is what made the inline form
 * affordable at all. Whole-line notes remain {@link markerLineRanges}'s job.
 */
export function markerSpanRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  NOTE_SPAN_RE.lastIndex = 0;
  for (;;) {
    const match = NOTE_SPAN_RE.exec(source);
    if (!match) break;
    const start = match.index;
    const end = source.indexOf("*/", start);
    if (end === -1) break;
    const withSpace = start > 0 && source[start - 1] === " " ? start - 1 : start;
    ranges.push([withSpace, end + 2]);
    NOTE_SPAN_RE.lastIndex = end + 2;
  }
  return ranges;
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
    if (NOTE_LINE_RE.test(source.slice(lineStart, lineEnd).trimStart())) {
      // Tagged or bare: `// @ts-capture[conflict]:` and `// @ts-capture:` are
      // both apply's, and a human who writes either loses it — the decision
      // that the marker is the tool's namespace.
      //
      // The marker has to end in `[` or `:`, though. `@ts-capture-ignore` is a
      // directive the user writes, and matching the bare prefix would have
      // apply delete it.
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
