// A buffered annotation insertion, awaiting batch verify before it
// becomes a `Replacement.insert(pos, text, priority)`. Shared by both
// appliers (offset-based `apply-types.ts` and AST-based
// `cst-replacements.ts`) so the verify-batch shape stays identical.
export type AnnotationCandidate = { pos: number; text: string; priority?: number };

export class Replacement {
  static insert(pos: number, text: string, priority = 0): Replacement {
    return new Replacement(pos, pos, text, priority);
  }

  static delete(start: number, end: number): Replacement {
    return new Replacement(start, end, "");
  }

  constructor(
    readonly start: number,
    readonly end: number,
    readonly text: string = "",
    readonly priority: number = 0,
  ) {}
}

export function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  const sorted = [...replacements].sort((a, b) =>
    b.end !== a.end
      ? b.end - a.end
      : a.start !== b.start
        ? b.start - a.start
        : a.priority - b.priority,
  );

  let result = source;
  for (const r of sorted) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }
  return result;
}
