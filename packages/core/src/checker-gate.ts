import type ts from "typescript";

import type { InferOptions } from "./configuration.js";

import {
  carriesPolymorphicThis,
  discardsUnionArm,
  erasesEnum,
  erasesNamedType,
  isRedundantAnnotation,
  observedBeyondInferred,
  writesOverCallSignature,
} from "./redundant-annotation.js";

// Whether to write an annotation, asked once for both appliers.
//
// The rules live in `redundant-annotation.ts`; what lives here is the order
// they are asked in, which is load-bearing. Each names one way the run can know
// *less* than TypeScript already does. A contradiction is what is left when
// none of them explains the difference, so it is asked after all of them — and
// redundancy last, because a restatement is only worth reporting once nothing
// worse is true.
//
// The order used to be written out four times: once in `apply-types.ts` and
// once per site kind in `cst-replacements.ts`. Three of the four had drifted,
// and the parameter branch was still missing the polymorphic-`this` rule when
// this was written.

export type GateVerdict =
  | { kind: "write" }
  | { kind: "suppress" }
  | { kind: "contradiction"; observed: string[] }
  | { kind: "redundant" };

const WRITE: GateVerdict = { kind: "write" };
const SUPPRESS: GateVerdict = { kind: "suppress" };

/**
 * What the checker says about writing `emitted` where it infers `inferred`.
 *
 * `suppress` and `redundant` both mean nothing is written; they are separate so
 * a caller can count restatements without counting losses.
 *
 * `contradiction` carries the arms the run saw and the type forbids. The caller
 * places the note — the two appliers reach the source and the site by different
 * routes — but nothing is written either way. A contradiction the applier
 * cannot report is still a contradiction.
 */
export function checkerGate(
  checker: ts.TypeChecker | undefined,
  inferred: ts.Type | undefined,
  emitted: string,
  infer: InferOptions,
): GateVerdict {
  if (!checker || !inferred) return WRITE;

  // `this` has no single value to write down: a concrete type here costs every
  // subclass its own. Not just return types — `const self = this` and a
  // contextually typed callback parameter are inferred `this` as well.
  if (carriesPolymorphicThis(checker, inferred)) return SUPPRESS;
  if (writesOverCallSignature(checker, inferred, emitted)) return SUPPRESS;
  if (erasesNamedType(checker, inferred, emitted)) return SUPPRESS;
  if (erasesEnum(checker, inferred, emitted)) return SUPPRESS;
  if (discardsUnionArm(checker, inferred, emitted)) return SUPPRESS;

  if (infer.emitConflictComments) {
    const observed = observedBeyondInferred(checker, inferred, emitted);
    if (observed) return { kind: "contradiction", observed };
  }

  // Asking for redundant annotations is asking for restatement, not for
  // destruction — so this one rule waits on the flag and the rest do not.
  if (infer.skipRedundantAnnotations && isRedundantAnnotation(checker, inferred, emitted)) {
    return { kind: "redundant" };
  }

  return WRITE;
}
