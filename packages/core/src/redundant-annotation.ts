import ts from "typescript";

import { sameTypeString } from "./type-canonical.js";

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
