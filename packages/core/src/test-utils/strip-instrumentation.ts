import ts from "typescript";

// The instrumenter only adds: take every `__tscptr__` call out of its output
// and the input's program is what remains. This is that removal.

export type CallForm = "param" | "ret" | "track" | "regFn" | "registerFn";

const RUNTIME = "__tscptr__";
const MEMBER_FORMS = new Set<string>(["ret", "track", "regFn", "registerFn"]);

/** The form of a `__tscptr__` call, or undefined for any other node. */
export function callFormOf(node: ts.Node): CallForm | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === RUNTIME ? "param" : undefined;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === RUNTIME &&
    MEMBER_FORMS.has(callee.name.text)
  ) {
    return callee.name.text as CallForm;
  }
  return undefined;
}

/** The two statements `skipTscptrDeclarations` leaves out. */
export function isRuntimeDeclaration(node: ts.Node): boolean {
  return (
    (ts.isFunctionDeclaration(node) || ts.isModuleDeclaration(node)) &&
    node.name?.getText() === RUNTIME &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false)
  );
}

// A call that returns its first argument stands where that argument stood;
// one that returns nothing was added as a statement or a comma operand.
const isPassThrough = (form: CallForm | undefined): boolean =>
  form === "ret" || form === "track" || form === "regFn";
const isAddedOperand = (form: CallForm | undefined): boolean =>
  form === "param" || form === "registerFn";

// An arrow's expression body is replaced by a comma list of the calls and the
// wrapped body, which the printer parenthesises.
function isAddedParens(node: ts.Node): boolean {
  if (!ts.isParenthesizedExpression(node) || !ts.isArrowFunction(node.parent)) return false;
  let leftmost = node.expression;
  while (ts.isBinaryExpression(leftmost) && isComma(leftmost)) leftmost = leftmost.left;
  return callFormOf(leftmost) !== undefined;
}

const isComma = (node: ts.BinaryExpression): boolean =>
  node.operatorToken.kind === ts.SyntaxKind.CommaToken;

/**
 * The tokens of the text as the printer spells them, one space apart: the
 * same for two texts that differ only in layout or comments.
 */
export function tokensOf(text: string, filename = "tokens.ts"): string {
  const printer = ts.createPrinter();
  const parse = (source: string): ts.SourceFile =>
    ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const sf = parse(printer.printFile(parse(text)));
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(node.getText(sf));
      return;
    }
    children.forEach(visit);
  };
  visit(sf);
  return tokens.join(" ");
}

/**
 * The tokens of the text with every `__tscptr__` call taken out. Run an input
 * through it too before comparing: `tokensOf` is the normal form of both.
 */
export function stripInstrumentation(text: string, filename = "stripped.ts"): string {
  const sf = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const strip: ts.TransformerFactory<ts.SourceFile> = (ctx) => {
    const visit = (original: ts.Node): ts.VisitResult<ts.Node | undefined> => {
      if (isRuntimeDeclaration(original)) return undefined;
      const addedParens = isAddedParens(original);
      const node = ts.visitEachChild(original, visit, ctx);

      if (ts.isExpressionStatement(node) && isAddedOperand(callFormOf(node.expression))) {
        return undefined;
      }
      if (ts.isCallExpression(node) && isPassThrough(callFormOf(node))) return node.arguments[0];
      if (ts.isBinaryExpression(node) && isComma(node) && isAddedOperand(callFormOf(node.left))) {
        return node.right;
      }
      if (addedParens && ts.isParenthesizedExpression(node)) return node.expression;
      return node;
    };
    return (file) => ts.visitNode(file, visit) as ts.SourceFile;
  };
  const [stripped] = ts.transform(sf, [strip]).transformed;
  return tokensOf(ts.createPrinter().printFile(stripped!), filename);
}
