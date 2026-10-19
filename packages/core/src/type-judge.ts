import ts from "typescript";

import type { TypeOracle } from "./annotate.js";
import type { CollectedTypeInfo } from "./type-collector.js";

import { findCloseParenPos } from "./instrumentation-site-spec.js";
import { unwrapOneLevelPromise } from "./named-type-rewrite.js";
import { parseObjectType } from "./type-merge.js";
import { unionArms } from "./type-text.js";

// What the run saw, held against the type TypeScript has at the position. One
// relation for every caller, so verify and the applier cannot disagree about
// what fits.
//
// The text rules answer first: what they call a match stays one. What they
// cannot answer goes to the checker, with each observed string resolved in the
// file's scope — declared at the end of a copy of the file, so every recorded
// position still points at the same code and both types come from one checker.
// The observed strings are written in the runtime's own dialect; the rules
// below read them the way the runtime meant them, and only ever turn a
// mismatch the checker cannot prove into `unverifiable`.

export type Verdict = "match" | "mismatch" | "unverifiable" | "no-declaration";

export interface Fit {
  verdict: Verdict;
  /** Why it is unverifiable, or why there is no declaration. */
  reason?: string;
  /** The observed arms the type forbids, on a mismatch the checker found. */
  outside?: string[];
  /** The type TypeScript has at the position, as it prints it. */
  declared: string | null;
  name?: string;
  /** One-based, at the declaration name or the return-type position. */
  line?: number;
  column?: number;
}

export interface TypeJudge {
  /** Does what the run saw fit the type TypeScript has here (written, else inferred; awaited for async)? */
  fits(entry: CollectedTypeInfo[number]): Fit;
}

type TextVerdict = { verdict: Verdict; reason?: string };

const ABOUT_THE_RUN = new Set(["no observations", "promise not settled"]);

/** Built once for a run: it sees every entry, so it resolves each file's observations in one pass. */
export function typeJudge(oracle: TypeOracle, types: CollectedTypeInfo): TypeJudge {
  const program =
    oracle.kind === "program"
      ? oracle.program
      : oracle.kind === "project"
        ? oracle.project.service.getProgram()
        : undefined;
  let checks: Checks | undefined;
  return {
    fits(entry) {
      const [file, pos, observedTuples, opts] = entry;
      if (!program) return { verdict: "unverifiable", reason: "no checker", declared: null };
      const sourceFile = program.getSourceFile(file);
      if (!sourceFile) {
        return { verdict: "no-declaration", reason: "source file not in program", declared: null };
      }
      // A parameter, variable or property is observed at the end of its name; a
      // return at the `)` where `: T` would go.
      const node = opts?.returnType
        ? findFunctionByReturnPos(sourceFile, pos)
        : findDeclarationByPos(sourceFile, pos);
      if (!node) {
        return {
          verdict: "no-declaration",
          reason: "no declaration at position",
          declared: null,
          ...locate(sourceFile, pos),
        };
      }
      const checker = program.getTypeChecker();
      const declared = resolveDeclaredType(node, checker);
      const observed = observedTuples.map(([t]) => t).filter((t): t is string => Boolean(t));
      const async = opts?.async === true && isFunctionLike(node);
      const where = {
        declared,
        ...locate(sourceFile, isFunctionLike(node) ? pos : node.name.getStart(sourceFile)),
        name: isFunctionLike(node) ? "return type" : normalize(node.name.getText(sourceFile)),
      };
      const text = async
        ? compareAwaited(observed, node, checker)
        : isCompatible(observed, declared);
      // A match the text found stays one; so does what it said about the run itself.
      if (
        text.verdict === "match" ||
        oracle.kind === "none" ||
        ABOUT_THE_RUN.has(text.reason ?? "")
      ) {
        return { ...text, ...where };
      }
      checks ??= new Checks(program, types);
      return { ...checks.fit(file, pos, observed, opts?.returnType === true, async), ...where };
    },
  };
}

// --- The checker ---

// A Rank orders what a comparison can conclude, from proven to refuted; the
// middle ones say the run cannot decide.
type Rank =
  | "fit"
  | "literal declared type"
  | "generic declared type"
  | "properties not observed"
  | "declared narrower than observable"
  | "too deep"
  | "out";
const RANK: Record<Rank, number> = {
  fit: 0,
  "literal declared type": 1,
  "generic declared type": 2,
  "properties not observed": 2,
  "declared narrower than observable": 2,
  "too deep": 3,
  out: 4,
};
const worse = (a: Rank, b: Rank): Rank => (RANK[a] >= RANK[b] ? a : b);
const better = (a: Rank, b: Rank): Rank => (RANK[a] <= RANK[b] ? a : b);

const BOXED = new Set(["String", "Number", "Boolean"]);
const ANY_FN = "__tscptr_AnyFn";

type Resolved = { type: ts.Type } | { unresolved: string };

class Checks {
  private readonly observedByFile = new Map<string, Set<string>>();
  private readonly arity = new Map<string, number>();
  private readonly importsByFile = new Map<string, Map<string, string>>();
  private readonly ambiguous = new Set<string>();
  private declOf = new Map<string, { name: string; start: number; end: number }>();
  private fork!: ts.Program;
  private checker!: ts.TypeChecker;
  private exportsByName = new Map<string, Map<string, string>>();
  private diagnostics = new Map<string, readonly ts.Diagnostic[]>();
  private dirty = true;

  constructor(
    private readonly base: ts.Program,
    types: CollectedTypeInfo,
  ) {
    for (const [file, , observed, opts] of types) {
      this.add(
        file,
        observed.map(([t]) => t).filter((t): t is string => Boolean(t)),
        opts?.async === true,
      );
    }
  }

  fit(
    file: string,
    pos: number,
    observed: string[],
    returnType: boolean,
    async: boolean,
  ): TextVerdict & { outside?: string[] } {
    if (this.add(file, observed, async)) this.dirty = true;
    if (this.dirty) this.build();
    const sf = this.fork.getSourceFile(file)!;
    const node = returnType ? findFunctionByReturnPos(sf, pos) : findDeclarationByPos(sf, pos);
    if (!node) return { verdict: "no-declaration", reason: "no declaration at position" };
    let target = declaredTypeOf(node, this.checker);
    if (!target) return { verdict: "unverifiable", reason: "no declared type" };
    if (async) target = this.checker.getAwaitedType(target) ?? target;
    if (target.flags & ts.TypeFlags.Any) return { verdict: "unverifiable", reason: "declared any" };
    if (target.flags & ts.TypeFlags.Unknown) {
      return { verdict: "unverifiable", reason: "declared unknown" };
    }

    const outside: string[] = [];
    let unsure: string | undefined;
    for (const raw of observed) {
      const arm = async ? unwrapOneLevelPromise(raw) : raw;
      if (this.ambiguous.has(arm)) {
        unsure ??= "function or array of functions";
        continue;
      }
      const resolved = this.resolve(file, arm);
      if ("unresolved" in resolved) {
        unsure ??= resolved.unresolved;
        continue;
      }
      const rank = this.fitDeep(resolved.type, target, 0);
      if (rank === "fit") continue;
      if (rank === "out") outside.push(raw);
      else unsure ??= rank;
    }
    if (outside.length > 0) return { verdict: "mismatch", outside };
    if (unsure) return { verdict: "unverifiable", reason: unsure };
    return { verdict: "match" };
  }

  /** True when an arm was new. */
  private add(file: string, observed: string[], async: boolean): boolean {
    let set = this.observedByFile.get(file);
    if (!set) this.observedByFile.set(file, (set = new Set()));
    const before = set.size;
    for (const t of observed) set.add(async ? unwrapOneLevelPromise(t) : t);
    return set.size > before;
  }

  // Two passes: the first finds which bare names are generic and which names
  // a file must import; the second declares the observations with both.
  private build(): void {
    this.fork = this.forked();
    this.checker = this.fork.getTypeChecker();
    this.diagnostics = new Map();
    this.learnNames();
    this.fork = this.forked();
    this.checker = this.fork.getTypeChecker();
    this.diagnostics = new Map();
    this.exportsByName = this.indexExports();
    this.dirty = false;
  }

  private forked(): ts.Program {
    const overlay = new Map<string, string>();
    this.declOf = new Map();
    this.ambiguous.clear();
    let n = 0;
    for (const [file, set] of this.observedByFile) {
      const sf = this.base.getSourceFile(file);
      if (!sf) continue;
      let text = `${sf.text}\ntype ${ANY_FN} = (...args: any[]) => any;\n`;
      for (const arm of set) {
        const name = `__tscptr_o${n++}`;
        const start = text.length;
        text += `declare const ${name}: ${this.dialect(arm, file)};\n`;
        this.declOf.set(`${file}\0${arm}`, { name, start, end: text.length });
      }
      overlay.set(file, text);
    }
    const options = this.base.getCompilerOptions();
    const host = ts.createCompilerHost(options, true);
    const fallback = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
      const text = overlay.get(fileName);
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
      // The base program's own file, unless it is a second copy of a package
      // TypeScript points at the first: a host may not hand those out.
      const known = this.base.getSourceFile(fileName);
      if (known && !(known as { redirectInfo?: unknown }).redirectInfo) return known;
      return fallback(fileName, languageVersion, onError, shouldCreate);
    };
    const readFile = host.readFile.bind(host);
    host.readFile = (fileName) =>
      overlay.get(fileName) ?? this.base.getSourceFile(fileName)?.text ?? readFile(fileName);
    host.fileExists = (fileName) =>
      overlay.has(fileName) ||
      this.base.getSourceFile(fileName) !== undefined ||
      ts.sys.fileExists(fileName);
    return ts.createProgram({
      rootNames: this.base.getRootFileNames(),
      options,
      host,
      oldProgram: this.base,
    });
  }

  /**
   * The runtime's dialect, read as it was meant: `unknown` is "nothing
   * observed"; a function is only known to be callable; a generic seen without
   * arguments had arguments the runtime could not see; `(a) => X[]` is also how
   * an array of functions is written, so it is ambiguous; a name the file does
   * not see is imported when exactly one module exports it.
   */
  private dialect(text: string, file: string): string {
    const sf = ts.createSourceFile(
      "__observed.ts",
      `type __T = ${text};`,
      ts.ScriptTarget.Latest,
      true,
    );
    const alias = sf.statements[0];
    if (!alias || !ts.isTypeAliasDeclaration(alias)) return text;
    const imports = this.importsByFile.get(file);
    const anyFn = (): ts.TypeNode => ts.factory.createTypeReferenceNode(ANY_FN);
    let ambiguous = false;
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
        const ret = node.type;
        if (
          ts.isArrayTypeNode(ret) ||
          (ts.isUnionTypeNode(ret) && ret.types.some(ts.isArrayTypeNode))
        ) {
          ambiguous = true;
        }
        return anyFn();
      }
      if (ts.isMethodSignature(node)) {
        return ts.factory.createPropertySignature(
          node.modifiers,
          node.name,
          node.questionToken,
          anyFn(),
        );
      }
      if (node.kind === ts.SyntaxKind.UnknownKeyword) {
        return ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
      }
      if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) {
        const from = imports?.get(node.exprName.text);
        if (from) return importType(from, node.exprName.text, undefined, true);
      }
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const name = node.typeName.text;
        if (name === "Function") return anyFn();
        const args =
          node.typeArguments?.map((a) => visit(a) as ts.TypeNode) ??
          (this.arity.has(name)
            ? Array.from({ length: this.arity.get(name)! }, () =>
                ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
              )
            : undefined);
        const from = imports?.get(name);
        if (from) return importType(from, name, args, false);
        if (args && !node.typeArguments) return ts.factory.createTypeReferenceNode(name, args);
      }
      return ts.visitEachChild(node, visit, undefined);
    };
    const out = printer.printNode(ts.EmitHint.Unspecified, visit(alias.type), sf);
    if (ambiguous) this.ambiguous.add(text);
    return out;
  }

  private learnNames(): void {
    const exports = this.indexExports();
    for (const file of this.observedByFile.keys()) {
      const sf = this.fork.getSourceFile(file);
      const end = this.base.getSourceFile(file)?.text.length;
      if (!sf || end === undefined) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments) {
          const symbol = this.checker.getSymbolAtLocation(node.typeName);
          const declared =
            symbol && (this.checker.getDeclaredTypeOfSymbol(symbol) as ts.InterfaceType);
          const params = declared?.typeParameters?.length;
          if (params) this.arity.set(node.typeName.text, params);
        }
        ts.forEachChild(node, visit);
      };
      for (const statement of sf.statements) if (statement.end > end) visit(statement);
      for (const name of this.namesNotFound(file)) {
        const modules = exports.get(name);
        if (modules?.size !== 1) continue;
        let imports = this.importsByFile.get(file);
        if (!imports) this.importsByFile.set(file, (imports = new Map()));
        imports.set(name, [...modules.values()][0]!);
      }
    }
  }

  /** Name → declaring module → the path to import it by. */
  private indexExports(): Map<string, Map<string, string>> {
    const byName = new Map<string, Map<string, string>>();
    const moduleKey = (f: string): string => f.replace(/\.d\.ts$|\.tsx?$/, "");
    for (const sf of this.fork.getSourceFiles()) {
      const moduleSymbol = this.checker.getSymbolAtLocation(sf);
      if (!moduleSymbol) continue;
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        const target =
          exported.flags & ts.SymbolFlags.Alias
            ? this.checker.getAliasedSymbol(exported)
            : exported;
        const declaration = target.declarations?.[0];
        if (!(target.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Value)) || !declaration)
          continue;
        let modules = byName.get(exported.name);
        if (!modules) byName.set(exported.name, (modules = new Map()));
        const key = moduleKey(declaration.getSourceFile().fileName);
        // `.js` resolves to the `.ts` or `.d.ts` under every moduleResolution.
        if (!modules.has(key)) modules.set(key, `${moduleKey(sf.fileName)}.js`);
      }
    }
    return byName;
  }

  private diagnosticsOf(file: string): readonly ts.Diagnostic[] {
    let found = this.diagnostics.get(file);
    if (!found) {
      const sf = this.fork.getSourceFile(file)!;
      found = [...this.fork.getSyntacticDiagnostics(sf), ...this.fork.getSemanticDiagnostics(sf)];
      this.diagnostics.set(file, found);
    }
    return found;
  }

  private namesNotFound(file: string, span?: { start: number; end: number }): string[] {
    const end = this.base.getSourceFile(file)?.text.length ?? 0;
    return this.diagnosticsOf(file)
      .filter(
        (d) =>
          d.code === 2304 &&
          d.start !== undefined &&
          d.start >= (span?.start ?? end) &&
          d.start < (span?.end ?? Infinity),
      )
      .map((d) => /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, " "))?.[1])
      .filter((name): name is string => name !== undefined);
  }

  private resolve(file: string, arm: string): Resolved {
    const declaration = this.declOf.get(`${file}\0${arm}`);
    if (!declaration) return { unresolved: "not a type" };
    const errors = this.diagnosticsOf(file).filter(
      (d) => d.start !== undefined && d.start >= declaration.start && d.start < declaration.end,
    );
    const missing = this.namesNotFound(file, declaration);
    if (missing.length > 0) {
      return {
        unresolved: missing.some((name) => (this.exportsByName.get(name)?.size ?? 0) > 1)
          ? "ambiguous name"
          : "name not in scope",
      };
    }
    // A bare generic without defaults still resolves, with `any` arguments.
    if (errors.some((d) => d.code !== 2314 && d.code !== 2707)) return { unresolved: "not a type" };
    const sf = this.fork.getSourceFile(file)!;
    const statement = sf.statements.find(
      (s): s is ts.VariableStatement =>
        ts.isVariableStatement(s) &&
        s.end > declaration.start &&
        s.declarationList.declarations[0]?.name.getText(sf) === declaration.name,
    );
    if (!statement) return { unresolved: "not a type" };
    return {
      type: this.checker.getTypeAtLocation(statement.declarationList.declarations[0]!.name),
    };
  }

  /** Sound for `fit` and `out`; anything between says the run cannot decide. */
  private fitDeep(o: ts.Type, t: ts.Type, depth: number): Rank {
    const c = this.checker;
    if (c.isTypeAssignableTo(o, t)) return "fit";
    if (depth > 6) return "too deep";
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "fit";
    if (o.isUnion())
      return o.types.reduce<Rank>((acc, arm) => worse(acc, this.fitDeep(arm, t, depth + 1)), "fit");
    const literals = t.isUnion() ? t.types : [t];
    if (
      literals.every(isLiteral) &&
      literals.some((l) => c.isTypeAssignableTo(o, c.getBaseTypeOfLiteralType(l)))
    ) {
      return "literal declared type";
    }
    // An observed primitive or named type is never narrower than the value: no
    // literals, brands, type arguments or TS-only refinements reach the
    // runtime. A declared type inside it cannot be refuted — except that a
    // boxed primitive really was an object. An observed shape lists every own
    // property the value had, so it is not wider in the same way.
    if (!isShape(o) && !isBoxedAgainstPrimitive(o, t) && c.isTypeAssignableTo(t, o)) {
      return "declared narrower than observable";
    }
    if (t.isIntersection())
      return t.types.reduce<Rank>((acc, m) => worse(acc, this.fitDeep(o, m, depth + 1)), "fit");
    if (t.isUnion())
      return t.types.reduce<Rank>((acc, m) => better(acc, this.fitDeep(o, m, depth + 1)), "out");
    // Only a type parameter has a constraint an observation can fall outside;
    // a conditional or indexed type over one, or a type that holds one
    // anywhere, cannot be decided by a run.
    if (t.flags & GENERIC && !(t.flags & ts.TypeFlags.TypeParameter))
      return "generic declared type";
    if (!(t.flags & ts.TypeFlags.TypeParameter) && mentionsTypeParameter(t, c, 0))
      return "generic declared type";
    if (t.flags & ts.TypeFlags.TypeParameter) {
      const constraint = c.getBaseConstraintOfType(t);
      if (!constraint || constraint.flags & ts.TypeFlags.Unknown || constraint === t)
        return "generic declared type";
      return this.fitDeep(o, constraint, depth + 1) === "out" ? "out" : "generic declared type";
    }
    if (isLiteral(t) && c.isTypeAssignableTo(o, c.getBaseTypeOfLiteralType(t)))
      return "literal declared type";
    if (c.isTupleType(t) && c.isTupleType(o)) {
      const declared = c.getTypeArguments(t as ts.TypeReference);
      const seen = c.getTypeArguments(o as ts.TypeReference);
      if (seen.length > declared.length) return "out";
      return seen.reduce<Rank>(
        (acc, e, i) => worse(acc, this.fitDeep(e, declared[i]!, depth + 1)),
        "fit",
      );
    }
    // The runtime cannot tell a tuple from an array: each element must fit some position.
    if (c.isTupleType(t) && c.isArrayType(o)) {
      const element = c.getTypeArguments(o as ts.TypeReference)[0]!;
      const positions = c.getTypeArguments(t as ts.TypeReference);
      const arms = element.isUnion() ? element.types : [element];
      return arms.reduce<Rank>(
        (acc, arm) =>
          worse(
            acc,
            positions.reduce<Rank>((b, p) => better(b, this.fitDeep(arm, p, depth + 1)), "out"),
          ),
        "fit",
      );
    }
    if (c.isArrayType(t) && c.isArrayType(o)) {
      return this.fitDeep(
        c.getTypeArguments(o as ts.TypeReference)[0]!,
        c.getTypeArguments(t as ts.TypeReference)[0]!,
        depth + 1,
      );
    }
    // An array is recorded by its elements and a function by being callable;
    // properties hung on either are not observed.
    if (
      c.isArrayType(o) &&
      t.flags & ts.TypeFlags.Object &&
      !c.isArrayType(t) &&
      !c.isTupleType(t)
    ) {
      return "properties not observed";
    }
    if (o.getCallSignatures().length > 0)
      return t.getCallSignatures().length > 0 ? "properties not observed" : "out";
    if (o.flags & ts.TypeFlags.Object && t.flags & ts.TypeFlags.Object)
      return this.fitMembers(o, t, depth);
    return "out";
  }

  private fitMembers(o: ts.Type, t: ts.Type, depth: number): Rank {
    const c = this.checker;
    const exactOptional = this.fork.getCompilerOptions().exactOptionalPropertyTypes === true;
    let acc: Rank = "fit";
    let absentUndefined = false;
    const shape = isShape(o);
    for (const property of c.getPropertiesOfType(t)) {
      const declared = c.getTypeOfSymbol(property);
      const seen = c.getPropertyOfType(o, property.name);
      if (!seen) {
        if (property.flags & ts.SymbolFlags.Optional) continue;
        // A missing key reads as `undefined`.
        if (!exactOptional && c.isTypeAssignableTo(c.getUndefinedType(), declared)) {
          absentUndefined = true;
          continue;
        }
        // A shape the runtime walked has neither symbol keys nor what a class
        // instance inherits from its prototype.
        if (
          shape &&
          (String(property.escapedName).startsWith("__@") ||
            property.flags & ts.SymbolFlags.Method ||
            declared.getCallSignatures().length > 0)
        ) {
          acc = worse(acc, "properties not observed");
          continue;
        }
        return "out";
      }
      acc = worse(acc, this.fitDeep(c.getTypeOfSymbol(seen), declared, depth + 1));
      if (acc === "out") return "out";
    }
    // Every member fits and the whole still does not: index signatures,
    // variance, generics the walk does not model.
    return acc === "fit" && !absentUndefined ? "too deep" : acc;
  }
}

const GENERIC =
  ts.TypeFlags.TypeParameter |
  ts.TypeFlags.Index |
  ts.TypeFlags.IndexedAccess |
  ts.TypeFlags.Conditional |
  ts.TypeFlags.Substitution;

const printer = ts.createPrinter();

function importType(
  from: string,
  name: string,
  args: readonly ts.TypeNode[] | undefined,
  typeOf: boolean,
): ts.TypeNode {
  return ts.factory.createImportTypeNode(
    ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(from)),
    undefined,
    ts.factory.createIdentifier(name),
    args,
    typeOf,
  );
}

function isShape(t: ts.Type): boolean {
  return (
    (t.flags & ts.TypeFlags.Object) !== 0 &&
    ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous) !== 0 &&
    t.getCallSignatures().length === 0
  );
}

function isPrimitive(t: ts.Type): boolean {
  return (
    (t.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike)) !==
    0
  );
}

function isBoxedAgainstPrimitive(o: ts.Type, t: ts.Type): boolean {
  if (!o.symbol || !BOXED.has(o.symbol.name)) return false;
  const arms = t.isUnion() ? t.types : [t];
  return arms.every((m) => isPrimitive(m) || (m.isIntersection() && m.types.some(isPrimitive)));
}

function isLiteral(t: ts.Type): boolean {
  return (
    (t.flags &
      (ts.TypeFlags.StringLiteral |
        ts.TypeFlags.NumberLiteral |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.EnumLiteral |
        ts.TypeFlags.BigIntLiteral |
        ts.TypeFlags.TemplateLiteral)) !==
    0
  );
}

function mentionsTypeParameter(t: ts.Type, checker: ts.TypeChecker, depth: number): boolean {
  if (depth > 8) return false;
  if (t.flags & GENERIC) return true;
  if (t.isUnionOrIntersection())
    return t.types.some((m) => mentionsTypeParameter(m, checker, depth + 1));
  const reference =
    t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
      ? checker.getTypeArguments(t as ts.TypeReference)
      : [];
  return [...(t.aliasTypeArguments ?? []), ...reference].some((a) =>
    mentionsTypeParameter(a, checker, depth + 1),
  );
}

/** The declared type at a node, as the checker has it; an optional parameter may be undefined. */
function declaredTypeOf(
  node: NamedDeclaration | FunctionLike,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (isFunctionLike(node)) return returnTypeOf(node, checker);
  if (ts.isParameter(node) && node.questionToken) return checker.getTypeAtLocation(node);
  return node.type ? checker.getTypeFromTypeNode(node.type) : checker.getTypeAtLocation(node);
}

// --- The text rules, and finding the declaration at a position ---

function locate(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

/**
 * Resolve the declared type for a node, preferring explicit annotations over
 * inferred types. For function-like nodes the return type is what we want;
 * for everything else it's the value type.
 */
function resolveDeclaredType(node: ts.Node, checker: ts.TypeChecker): string {
  if (isFunctionLike(node)) {
    const type = returnTypeOf(node, checker);
    return type ? checker.typeToString(type) : "unknown";
  }
  const explicitType = (node as ts.HasType).type;
  if (explicitType) {
    const written = checker.typeToString(checker.getTypeFromTypeNode(explicitType));
    // `x?: T` may be left out, which a call observes as `undefined`.
    const optional = ts.isParameter(node) && node.questionToken !== undefined;
    if (!optional || unionArms(written).includes("undefined")) return written;
    return isFunctionType(written) ? `(${written}) | undefined` : `${written} | undefined`;
  }
  return checker.typeToString(checker.getTypeAtLocation(node));
}

function returnTypeOf(node: FunctionLike, checker: ts.TypeChecker): ts.Type | undefined {
  if (node.type) return checker.getTypeFromTypeNode(node.type);
  return checker.getSignatureFromDeclaration(node)?.getReturnType();
}

// An async return is observed as what its promise resolved to, so it is
// compared with the awaited type; the report still shows the `Promise<T>`.
function compareAwaited(
  observed: string[],
  node: FunctionLike,
  checker: ts.TypeChecker,
): TextVerdict {
  if (observed.includes("Promise"))
    return { verdict: "unverifiable", reason: "promise not settled" };
  const type = returnTypeOf(node, checker);
  const awaited = type && checker.getAwaitedType(type);
  if (!awaited) return { verdict: "unverifiable", reason: "no awaited type" };
  return isCompatible(observed.map(unwrapOneLevelPromise), checker.typeToString(awaited));
}

/**
 * Find the parameter / variable / property declaration whose name ends at the
 * given offset. ts-capture's instrumenter records observations at `name.getEnd()`,
 * which is exactly where a `: Type` annotation would be inserted, so this
 * matches the position the runtime data was tagged with.
 */
type NamedDeclaration = (
  ts.ParameterDeclaration | ts.VariableDeclaration | ts.PropertyDeclaration
) & {
  name: ts.Identifier | ts.BindingPattern;
};

function findDeclarationByPos(sourceFile: ts.SourceFile, pos: number): NamedDeclaration | null {
  let found: NamedDeclaration | null = null;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      // A destructured parameter is observed whole, at the end of its pattern.
      (ts.isIdentifier(node.name) || ts.isParameter(node)) &&
      (node.name.getEnd() === pos || node.name.getEnd() + 1 === pos) /* optional `?` */
    ) {
      found = node as NamedDeclaration;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Find the function-like node whose return position is `pos`, computed the
 * way the instrumenter computes it (`findCloseParenPos`), paren-less arrows
 * included.
 */
function findFunctionByReturnPos(sourceFile: ts.SourceFile, pos: number): FunctionLike | null {
  let found: FunctionLike | null = null;
  function visit(node: ts.Node) {
    if (found) return;
    if (isFunctionLike(node) && findCloseParenPos(node, sourceFile) === pos) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/**
 * Heuristic compatibility check between observed runtime type-names and the
 * declared TS type. Handles primitives, simple unions, `T | undefined`
 * optionals, and homogeneous arrays. Returns `unverifiable` for anything
 * involving generics, structural object types, or function types — these need
 * a real subtype check that the ts-capture core does not currently expose.
 */
export function isCompatible(observed: string[], declared: string): TextVerdict {
  if (observed.length === 0) return { verdict: "unverifiable", reason: "no observations" };

  const declaredNorm = normalize(declared);

  // Anything declared as `any`, or as an array of it, cannot be invalidated by observations.
  if (/^any(?:\[\])*$/.test(declaredNorm))
    return { verdict: "unverifiable", reason: "declared any" };

  // unknown is similarly compatible with anything.
  if (declaredNorm === "unknown") return { verdict: "unverifiable", reason: "declared unknown" };

  // Polymorphic `this` is the receiver's class, which the observation names
  // but the declaration does not.
  if (declaredNorm === "this") return { verdict: "unverifiable", reason: "declared this" };

  // A union with a function, object or generic arm, `((e: Error) => void) |
  // undefined`: each observation is held against each arm on its own.
  const arms = unionArms(declaredNorm);
  if (arms.length > 1 && arms.some(isComplex)) return compareArms(observed, arms);

  // Function types: declared `(args) => ret` (possibly with generics prefix).
  // Observed values from getTypeName for functions look like
  // `(arg0: unknown, ...) => unknown`. We can't compare param/return types
  // deeply (observed is always `unknown` there), but we CAN tell whether
  // observed is a function at all — a non-function observation against a
  // function-typed declaration is a real mismatch.
  if (isFunctionType(declaredNorm)) {
    const normalized = observed.map(normalize);
    if (!normalized.every(isFunctionObservation)) return { verdict: "mismatch" };
    // A class is called with `new`; whether it is also callable the text cannot say.
    if (normalized.some((o) => o.startsWith("typeof ")))
      return { verdict: "unverifiable", reason: "class for a call signature" };
    return { verdict: "match" };
  }

  // Structural object types: `{ a: T, b?: U }`.
  // Parse both declared and each observation as a key→type map; require all
  // non-optional declared keys to be present in observation, and recursively
  // verify the shared keys' value types.
  if (declaredNorm.startsWith("{") && declaredNorm.endsWith("}")) {
    return structuralCompat(declaredNorm, observed);
  }

  // Exact-equality fallback for generic types (`Set<string>`, `Map<K, V>`,
  // `Promise<T>`, …) BEFORE we bail. getTypeName produces these same strings
  // for matching runtime values, so character-for-character equality is a
  // legitimate (if conservative) match signal — `Set<string>` declared and
  // `Set<string>` observed should not get filed as unverifiable just because
  // we can't reason about the type-parameter relation.
  if (isComplex(declaredNorm)) {
    const allEqual = observed.every((o) => normalize(o) === declaredNorm);
    if (allEqual) return { verdict: "match" };
    return { verdict: "unverifiable", reason: "complex declared type" };
  }

  const declaredVariants = parseUnion(declaredNorm)
    .map(normalize)
    .map((v) => v.replace(/^readonly /, ""));

  let unverifiable: TextVerdict | undefined;
  for (const obs of observed) {
    if (obs == null) continue;
    const observedNorm = normalize(obs);
    if (observedFits(observedNorm, declaredVariants)) continue;
    const reason = whyNoContradiction(observedNorm, declaredVariants);
    if (!reason) return { verdict: "mismatch" };
    unverifiable ??= { verdict: "unverifiable", reason };
  }
  return unverifiable ?? { verdict: "match" };
}

const PRIMITIVES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "null",
  "undefined",
  "void",
  "never",
  "object",
]);

const LITERAL_FAMILY: Array<[RegExp, string]> = [
  [/^(?:"[^"]*"|'[^']*')$/, "string"],
  [/^-?\d+n$/, "bigint"],
  [/^-?\d+(?:\.\d+)?$/, "number"],
  [/^(?:true|false)$/, "boolean"],
];

const literalFamily = (t: string): string | undefined =>
  LITERAL_FAMILY.find(([re]) => re.test(t))?.[1];

const isPrimitiveOrLiteral = (t: string): boolean =>
  PRIMITIVES.has(t) || literalFamily(t) !== undefined;

/** A primitive or a literal, or an array of one. */
const isPlain = (t: string): boolean => isPrimitiveOrLiteral(t.replace(/(?:\[\])+$/, ""));

// An observation outside every arm contradicts the written type only when the
// text says what every arm holds. A name may stand for any shape the run saw,
// and a literal arm is widened by the run (`"ws"` is observed as `string`).
function whyNoContradiction(observed: string, declaredVariants: string[]): string | undefined {
  if (declaredVariants.some((v) => !isPlain(v))) return "named declared type";
  if (declaredVariants.some((v) => literalFamily(v) === observed)) return "literal declared type";
  return undefined;
}

function compareArms(observed: string[], arms: string[]): TextVerdict {
  let unverifiable: TextVerdict | undefined;
  for (const obs of observed) {
    const outcomes = arms.map((arm) => isCompatible([obs], unparenthesize(arm)));
    if (outcomes.some((o) => o.verdict === "match")) continue;
    const unsure = outcomes.find((o) => o.verdict === "unverifiable");
    if (!unsure) return { verdict: "mismatch" };
    unverifiable ??= unsure;
  }
  return unverifiable ?? { verdict: "match" };
}

function unparenthesize(t: string): string {
  if (!t.startsWith("(") || !t.endsWith(")")) return t;
  let depth = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    if (depth === 0) return t;
  }
  return t.slice(1, -1).trim();
}

function normalize(t: string): string {
  return t.trim().replace(/\s+/g, " ");
}

function isComplex(t: string): boolean {
  // Anything with <, {, ( indicates generics, structural types, or function
  // types — beyond MVP heuristic scope.
  return /[<{(]/.test(t);
}

/**
 * Detect a function-type signature like `(args) => ret` or
 * `<T>(args) => ret`. Heuristic: the signature contains a top-level `=>`
 * preceded by a parenthesised parameter list. Optional leading
 * `<T, U>` generics block is allowed.
 */
function isFunctionType(t: string): boolean {
  // Strip leading generics block if present
  const noGenerics = stripLeadingGenerics(t);
  return /^\(.*\)\s*=>/.test(noGenerics);
}

/**
 * Structural compatibility for `{ k: T, ... }` types. Each observation must:
 *   - itself be parseable as an object type
 *   - contain every non-optional declared key
 *   - match the value type for every shared key (recursively via isCompatible)
 * Index signatures (`[k: string]: T`) and complex constructs in declared keys
 * gracefully degrade to `unverifiable`.
 */
function structuralCompat(declared: string, observed: string[]): TextVerdict {
  const declaredMap = parseObjectType(declared);
  if (!declaredMap)
    return { verdict: "unverifiable", reason: "could not parse structural declared type" };

  // Index signatures or other unparseable shapes — bail.
  if ([...declaredMap.keys()].some((k) => k.startsWith("[") || k.startsWith("readonly ["))) {
    return { verdict: "unverifiable", reason: "index signature in declared type" };
  }

  let unverifiable: TextVerdict | undefined;
  for (const obs of observed) {
    const observedNorm = normalize(obs);
    if (!observedNorm.startsWith("{") || !observedNorm.endsWith("}")) {
      if (observedNorm === "null" || observedNorm === "undefined") return { verdict: "mismatch" };
      // A primitive has its wrapper's members (`"abc"` fits `{ length: number }`),
      // and a class or an instance by name may well have the keys.
      unverifiable ??= isPrimitiveOrLiteral(observedNorm)
        ? { verdict: "unverifiable", reason: "primitive for an object type" }
        : { verdict: "unverifiable", reason: "named observed type" };
      continue;
    }
    const parsed = parseObjectType(observedNorm);
    if (!parsed)
      return { verdict: "unverifiable", reason: "could not parse structural observed type" };
    const observedMap = methodsAsProperties(parsed);

    for (const [rawKey, declaredValueType] of declaredMap) {
      const { key, optional } = parseKey(rawKey);
      const obsValue = observedMap.get(key) ?? observedMap.get(`readonly ${key}`);
      if (obsValue === undefined) {
        if (optional) continue;
        return { verdict: "mismatch" };
      }
      // Recurse — verify this single field. If recursion bails as
      // unverifiable, accept the field (we have no negative evidence).
      const inner = isCompatible([obsValue], stripFieldModifiers(declaredValueType));
      if (inner.verdict === "mismatch") return { verdict: "mismatch" };
    }
  }

  return unverifiable ?? { verdict: "match" };
}

// An observed method, `f(x: T): U`, is a property holding `(x: T) => U`.
function methodsAsProperties(observed: Map<string, string>): Map<string, string> {
  const properties = new Map<string, string>();
  for (const [key, value] of observed) {
    const method = /^([\w$]+)\??\((.*)\)$/s.exec(key);
    if (method) properties.set(method[1], `(${method[2]}) => ${value}`);
    else properties.set(key, value);
  }
  return properties;
}

// A mock or a bound function is walked as an object with `apply` and `bind`;
// a class is observed as `typeof Name`.
function isFunctionObservation(observed: string): boolean {
  return (
    observed === "Function" ||
    observed.startsWith("typeof ") ||
    isFunctionType(observed) ||
    (observed.startsWith("{") && /\bapply\(/.test(observed) && /\bbind\(/.test(observed))
  );
}

function parseKey(rawKey: string): { key: string; optional: boolean } {
  let k = rawKey.trim();
  if (k.startsWith("readonly ")) k = k.slice("readonly ".length).trim();
  const optional = k.endsWith("?");
  if (optional) k = k.slice(0, -1).trim();
  return { key: k, optional };
}

function stripFieldModifiers(t: string): string {
  return t.trim().replace(/^readonly\s+/, "");
}

function stripLeadingGenerics(t: string): string {
  if (!t.startsWith("<")) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "<") depth++;
    else if (t[i] === ">") {
      depth--;
      if (depth === 0) return t.slice(i + 1).trimStart();
    }
  }
  return t;
}

function parseUnion(t: string): string[] {
  // After the isComplex bail, the remaining types are plain identifier-or-
  // identifier[] tokens, so a top-level pipe split is safe.
  return t
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function observedFits(observed: string, declaredVariants: string[]): boolean {
  // An empty array is observed as `unknown[]`.
  if (observed === "unknown[]" && declaredVariants.some((v) => v.endsWith("[]"))) return true;
  if (declaredVariants.includes("object") && !isPrimitiveOrLiteral(observed)) return true;

  // Bail on observed types that are themselves complex — they came from
  // getTypeName which can produce structural strings.
  if (isComplex(observed)) {
    // Fall back to substring match — better than nothing for `Array<T>` etc.
    return declaredVariants.some((v) => v === observed);
  }

  if (declaredVariants.includes(observed)) return true;

  // A function without a return statement is inferred `void` and observed `undefined`.
  if (observed === "undefined" && declaredVariants.includes("void")) return true;

  // Homogeneous array compatibility: observed `T[]` matches declared `T[]`.
  if (observed.endsWith("[]")) {
    const elem = observed.slice(0, -2).trim();
    return declaredVariants.some(
      (v) => v.endsWith("[]") && observedFits(elem, [v.slice(0, -2).trim()]),
    );
  }

  return false;
}
