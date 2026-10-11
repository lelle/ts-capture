import ts from "typescript";

export type TokenKind =
  | "comment"
  | "keyword"
  | "name"
  | "number"
  | "punctuation"
  | "space"
  | "string"
  | "type";

export interface Token {
  kind: TokenKind;
  text: string;
}

export interface MarkedToken extends Token {
  added: boolean;
}

const TYPE_WORDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.VoidKeyword,
]);

const STRINGS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

const COMMENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
]);

function kindOf(kind: ts.SyntaxKind): TokenKind {
  if (
    kind === ts.SyntaxKind.WhitespaceTrivia ||
    kind === ts.SyntaxKind.NewLineTrivia
  ) {
    return "space";
  }
  if (COMMENTS.has(kind)) return "comment";
  if (STRINGS.has(kind)) return "string";
  if (TYPE_WORDS.has(kind)) return "type";
  if (
    kind === ts.SyntaxKind.NumericLiteral ||
    kind === ts.SyntaxKind.BigIntLiteral
  )
    return "number";
  if (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword)
    return "keyword";
  if (
    kind >= ts.SyntaxKind.FirstPunctuation &&
    kind <= ts.SyntaxKind.LastPunctuation
  ) {
    return "punctuation";
  }
  return "name";
}

/**
 * The code as tokens, every character kept. Works on a fragment: a snippet cut
 * from the middle of a class is scanned, not parsed.
 */
export function tokenize(code: string): Token[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /*skipTrivia*/ false,
    ts.LanguageVariant.Standard,
    code,
  );
  const tokens: Token[] = [];
  // One entry per template literal being read: the braces open inside its
  // current substitution. At zero, a `}` closes the substitution.
  const templates: number[] = [];

  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    const depth = templates.length - 1;
    if (kind === ts.SyntaxKind.CloseBraceToken && depth >= 0) {
      if (templates[depth] === 0) {
        kind = scanner.reScanTemplateToken(/*isTaggedTemplate*/ false);
        if (kind === ts.SyntaxKind.TemplateTail) templates.pop();
      } else {
        templates[depth] -= 1;
      }
    } else if (kind === ts.SyntaxKind.OpenBraceToken && depth >= 0) {
      templates[depth] += 1;
    } else if (kind === ts.SyntaxKind.TemplateHead) {
      templates.push(0);
    }
    tokens.push({ kind: kindOf(kind), text: scanner.getTokenText() });
  }
  return tokens;
}

/**
 * Indices into `after` of the tokens a longest common subsequence leaves out.
 *
 * Read from the end, so that of two equal tokens the later one is kept: in
 * `find(id): { id: string } {` the brace `before` had is the last one, and the
 * annotation's own brace is the one that was added.
 */
function addedIndices(before: Token[], after: Token[]): Set<number> {
  const cols = after.length + 1;
  const length = new Uint32Array((before.length + 1) * cols);
  for (let i = 1; i <= before.length; i++) {
    for (let j = 1; j <= after.length; j++) {
      length[i * cols + j] =
        before[i - 1].text === after[j - 1].text
          ? length[(i - 1) * cols + j - 1] + 1
          : Math.max(length[(i - 1) * cols + j], length[i * cols + j - 1]);
    }
  }
  const added = new Set<number>();
  let i = before.length;
  let j = after.length;
  while (j > 0) {
    if (i > 0 && before[i - 1].text === after[j - 1].text) {
      i -= 1;
      j -= 1;
    } else if (i > 0 && length[(i - 1) * cols + j] > length[i * cols + j - 1]) {
      i -= 1;
    } else {
      j -= 1;
      added.add(j);
    }
  }
  return added;
}

/**
 * `after`, with each token marked as added when `before` does not have it.
 *
 * White space is compared by its neighbours, never by its own text: a space
 * is added when it sits between two added tokens, and a line break when the
 * whole line before it was added.
 */
export function markAdded(before: Token[], after: Token[]): MarkedToken[] {
  const significant = (tokens: Token[]) =>
    tokens
      .map((token, index) => ({ index, token }))
      .filter(({ token }) => token.kind !== "space");
  const afterSignificant = significant(after);
  const addedAmongSignificant = addedIndices(
    significant(before).map(({ token }) => token),
    afterSignificant.map(({ token }) => token),
  );
  const marked: MarkedToken[] = after.map((token) => ({
    ...token,
    added: false,
  }));
  afterSignificant.forEach(({ index }, position) => {
    marked[index].added = addedAmongSignificant.has(position);
  });

  const neighbour = (from: number, step: number): MarkedToken | undefined => {
    for (let i = from + step; i >= 0 && i < marked.length; i += step) {
      if (marked[i].kind !== "space") return marked[i];
    }
    return undefined;
  };
  const lineBeforeIsAdded = (index: number): boolean => {
    let seen = false;
    for (let i = index - 1; i >= 0; i--) {
      if (marked[i].kind === "space") {
        if (marked[i].text.includes("\n")) break;
        continue;
      }
      if (!marked[i].added) return false;
      seen = true;
    }
    return seen;
  };
  marked.forEach((token, index) => {
    if (token.kind !== "space") return;
    token.added = token.text.includes("\n")
      ? lineBeforeIsAdded(index)
      : Boolean(neighbour(index, -1)?.added && neighbour(index, 1)?.added);
  });
  return marked;
}
