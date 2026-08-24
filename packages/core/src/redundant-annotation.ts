import ts from "typescript";

import {
  canonicalUnionArms,
  containsTypeLiteral,
  sameTypeString,
  typeReferenceNames,
} from "./type-canonical.js";

// Is the annotation we are about to write already implied by TypeScript's own
// inference — or worse than it?
//
// The syntactic approximation in `initializer-inference.ts` answers a narrower
// version of this question by pattern-matching initializer shapes, and needs a
// new branch for every shape it does not know. When a `ts.Program` is
// available the checker answers it exactly, for every shape at once.
//
// This matters beyond tidiness. On a `const`, TypeScript infers a *narrower*
// type than the runtime observes: `'lit'` not `string`, `5` not `number`,
// `unique symbol` not `symbol`. Writing the observed type there does not add
// information, it destroys it — a widened `VERSION_NEUTRAL: symbol` on
// nestjs/nest silently broke every `value === VERSION_NEUTRAL` narrowing
// downstream and produced three compile errors in files that never mention it.

/**
 * The type string TypeScript's inference is worth, compared against what
 * ts-capture would emit.
 *
 * Literal types are widened to their base (`'lit'` → `string`), because that
 * is the form a runtime observation takes: seeing the string `'lit'` is
 * reported as `string`. If the widened form matches what we would write, our
 * annotation is at best a restatement.
 */
export function widenedTypeString(checker: ts.TypeChecker, type: ts.Type): string {
  // `getBaseTypeOfLiteralType` widens string/number/boolean/enum literals but
  // leaves `unique symbol` alone, so that one is handled explicitly.
  if (type.flags & ts.TypeFlags.UniqueESSymbol) return "symbol";
  // NoTruncation: the printer's default width elides a long object type as
  // `... 8 more ...`, which describes no type and can never match one.
  return checker.typeToString(
    checker.getBaseTypeOfLiteralType(type),
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  );
}

/**
 * True when the annotation adds nothing TypeScript does not already know.
 *
 * Returns false whenever the question cannot be answered — no checker, no
 * resolved type, or an inference of `any`/`unknown`, which is precisely the
 * case ts-capture exists to fill. Callers then fall back to their existing
 * syntactic guards.
 *
 * Only the same type is suppressed — not the same string. The checker prints
 * `string | undefined` where ts-capture writes `string|undefined`, and
 * `{ a: number; b: string; }` where ts-capture writes `{ b: string, a: number }`;
 * comparing those as text meant no union and no object type was ever
 * recognised as a restatement. What still lands: when we observed `Cat | Dog`
 * and TypeScript infers `Cat`, the types differ, and that is real information
 * from the run.
 */
export function isRedundantAnnotation(
  checker: ts.TypeChecker | undefined,
  inferred: ts.Type | undefined,
  emitted: string,
): boolean {
  if (!checker || !inferred) return false;
  if (inferred.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  return sameTypeString(widenedTypeString(checker, inferred), emitted);
}

/**
 * Does the checker's type carry a polymorphic `this`?
 *
 * A method that returns `this` keeps working in a subclass: with
 * `class Sub extends Builder {}`, `new Sub().addValidator(v)` is a `Sub`.
 * A run only ever observes the concrete instance it saw, so ts-capture writes
 * the class name — and every subclass caller gets the base class back. The
 * annotation cannot be right: the type it replaces has no single value.
 *
 * Recognised by what the checker prints. A this-type prints as `this`, and no
 * declaration can take that name, so the string is unambiguous.
 *
 * Searched wherever it can hide, not just at the top: `this | undefined` loses
 * what `this` does, and so do `Promise<this>` and `this[]`. `Promise<this>` is
 * the ordinary shape of an async fluent API, since a builder that awaits cannot
 * return `this` bare.
 */
export function carriesPolymorphicThis(
  checker: ts.TypeChecker | undefined,
  type: ts.Type | undefined,
  depth = 0,
): boolean {
  if (!checker || !type || depth > 4) return false;
  if (checker.typeToString(type) === "this") return true;
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some((t) => carriesPolymorphicThis(checker, t, depth + 1));
  }
  return typeArgumentsOf(checker, type).some((t) => carriesPolymorphicThis(checker, t, depth + 1));
}

/**
 * The type arguments of `Promise<T>`, `T[]`, `Map<K, V>` — empty for anything
 * that is not a generic reference.
 *
 * Several rules here ask what a type is made of. A loss is a loss at any depth:
 * writing `Promise<string>` over `Promise<Mode>` costs the same `mode === Mode.A`
 * downstream that the bare case costs.
 */
function typeArgumentsOf(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  const isReference =
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
  return isReference ? checker.getTypeArguments(type as ts.TypeReference) : [];
}

/**
 * Would this annotation replace a type TypeScript names with a bare shape?
 *
 * A reader who sees `RouteInfo[]` knows where to look. A reader who sees
 * `{ method: number, path: string }[]` cannot tell whether the expansion is
 * complete — and on nestjs/nest several were not: one dropped a field, and
 * four turned an enum into `number`, which every `RequestMethod.Get` comparison
 * downstream then loses.
 *
 * Fires only when the annotation is a *shape*. When the run produces a name
 * TypeScript does not have — `server-kafka` writes `ConsumerConfig` where the
 * checker has the structure — the annotation is the better one and lands.
 * Writing a primitive over a name is a different loss, left to its own rule.
 */
export function erasesNamedType(
  checker: ts.TypeChecker | undefined,
  inferred: ts.Type | undefined,
  emitted: string,
): boolean {
  if (!checker || !inferred) return false;
  if (inferred.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  if (!containsTypeLiteral(emitted)) return false;
  const written = typeReferenceNames(emitted);
  const known = typeReferenceNames(
    checker.typeToString(inferred, undefined, ts.TypeFormatFlags.NoTruncation),
  );
  for (const name of known) {
    if (!written.has(name)) return true;
  }
  return false;
}

/**
 * Would this annotation reject values the checker accepts?
 *
 * Every other rule here refuses an annotation that says *less* than TypeScript
 * already knows. This one refuses the opposite mistake, which is the more
 * dangerous of the two: writing a type narrower than the inferred one does not
 * remove an error, it introduces one. nest's `server-grpc` writes `string`
 * where the checker has `string | symbol`, and it compiles today only because
 * no caller at that site passes a symbol yet.
 *
 * A dropped `undefined` or `null` does not count: `?:` supplies the
 * `undefined` itself, so writing `string` for a `string | undefined` parameter
 * is how an optional parameter is meant to be spelled. Only payload arms are
 * information a caller can lose.
 *
 * An annotation that both drops and adds — widening `"a" | "b"` to `string` —
 * is not a discard, and keeps whatever verdict its own rule gives it.
 */
export function discardsUnionArm(
  checker: ts.TypeChecker | undefined,
  inferred: ts.Type | undefined,
  emitted: string,
): boolean {
  if (!checker || !inferred) return false;
  if (inferred.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const known = canonicalUnionArms(
    checker.typeToString(inferred, undefined, ts.TypeFormatFlags.NoTruncation),
  );
  const written = canonicalUnionArms(emitted);
  if (!known || !written) return false;
  if (written.some((arm) => !known.includes(arm))) return false;
  return known.some((arm) => !written.includes(arm) && arm !== "undefined" && arm !== "null");
}

/**
 * Would this annotation erase an enum into what it is made of?
 *
 * An enum is a name with meaning attached; the run sees only the string or the
 * number underneath. Writing that observation replaces `UuidFactoryMode` with
 * `string`, and every `mode === UuidFactoryMode.Random` downstream stops
 * meaning anything — the same damage a const assertion takes, arriving by a
 * different route.
 *
 * Deliberately narrow. An interface widened to a primitive is a different
 * loss, and `"headers" | "topic" | (string & {})` is not a name at all: that
 * type accepts any string, so writing `string` costs editor autocomplete
 * rather than type safety.
 */
export function erasesEnum(
  checker: ts.TypeChecker | undefined,
  inferred: ts.Type | undefined,
  emitted: string,
  depth = 0,
): boolean {
  if (!checker || !inferred || depth > 4) return false;
  const written = typeReferenceNames(emitted);
  if (!inferred.isUnion()) {
    // `Promise<Mode>` and `Mode[]` erase the same name the bare enum does.
    const args = typeArgumentsOf(checker, inferred);
    if (args.some((arg) => erasesEnum(checker, arg, emitted, depth + 1))) return true;
  }
  const arms = inferred.isUnion() ? inferred.types : [inferred];
  return arms.some((arm) => {
    if (!(arm.flags & ts.TypeFlags.EnumLike)) {
      return arm !== inferred && erasesEnum(checker, arm, emitted, depth + 1);
    }
    const name = arm.aliasSymbol?.name ?? arm.getSymbol()?.name;
    // An enum literal's own symbol is the member (`Random`); the enum it
    // belongs to is what a reader would lose, so check both spellings.
    const printed = checker.typeToString(arm).split(".")[0];
    return !written.has(printed) && (name === undefined || !written.has(name));
  });
}

/** Does this annotation name the untyped `Function` anywhere in it? */
function namesFunctionType(emitted: string): boolean {
  const sf = ts.createSourceFile(
    "__function_probe.ts",
    `type __X = ${emitted};`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
  );
  const stmt = sf.statements[0];
  if (!stmt || !ts.isTypeAliasDeclaration(stmt)) return false;
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === "Function"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(stmt.type);
  return found;
}

/** Is there a call signature anywhere in this type — in a union arm, or an element? */
function hasCallSignature(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (depth > 4) return false;
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return true;
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some((t) => hasCallSignature(checker, t, depth + 1));
  }
  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return element ? hasCallSignature(checker, element, depth + 1) : false;
}

/**
 * Would this annotation write `Function` over a signature TypeScript has?
 *
 * `Function` is a fair answer when the run saw a function it could not
 * describe — a native one that instrumentation never reached, say. It says
 * only "callable": no arity, no parameter types, no return type. Where the
 * checker already has a real signature, writing it replaces an answer with a
 * shrug.
 *
 * On nestjs/nest, six sites wrote `Function` over the `reject` of
 * `new Promise((resolve, reject) => …)`, which TypeScript types
 * `(reason?: any) => void`, and two wrote `Function[]` over an array of
 * constructor signatures.
 */
export function writesOverCallSignature(
  checker: ts.TypeChecker | undefined,
  inferred: ts.Type | undefined,
  emitted: string,
): boolean {
  if (!checker || !inferred) return false;
  if (inferred.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  if (!namesFunctionType(emitted)) return false;
  return hasCallSignature(checker, inferred);
}

/** Type the checker infers at a node, or undefined when it cannot be asked. */
export function typeAt(
  checker: ts.TypeChecker | undefined,
  node: ts.Node | undefined,
): ts.Type | undefined {
  if (!checker || !node) return undefined;
  return checker.getTypeAtLocation(node);
}

/**
 * Return type the checker infers for a function-like node. Not
 * `getTypeAtLocation`, which would give the function's own type.
 */
export function inferredReturnType(
  checker: ts.TypeChecker | undefined,
  node: ts.SignatureDeclaration | undefined,
): ts.Type | undefined {
  if (!checker || !node) return undefined;
  return checker.getSignatureFromDeclaration(node)?.getReturnType();
}
