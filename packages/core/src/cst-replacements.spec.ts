import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { DiscoveredType } from "./collector-contract.js";
import type { CollectedTypeEntry, CollectedTypeInfo, ExtraOptions } from "./type-collector.js";

import { INFER_DEFAULTS } from "./configuration.js";
import { buildCstReplacements, type CstApplyContext } from "./cst-replacements.js";
import { routeEntries } from "./cst-routing.js";
import { buildCstSiteIndex } from "./cst-site-index.js";

// Direct specs for replacement-building. The
// behavioral heart is covered comprehensively by the 56-case apply-types-cst
// round-trip oracle; these probe a few behaviors directly off the Replacement
// list for sharper failure localization.

function emptyCtx(over: Partial<CstApplyContext> = {}): CstApplyContext {
  return { infer: INFER_DEFAULTS, prefix: "", ...over };
}

/** parse → index → route → build, returning the Replacement list. */
function build(src: string, entries: CollectedTypeInfo, ctx: CstApplyContext = emptyCtx()) {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const index = buildCstSiteIndex(sf, src, ctx.infer);
  const { eligible } = routeEntries(entries, index, ctx.infer, ctx.telemetry);
  return buildCstReplacements(eligible, index, ctx);
}

const entry = (
  pos: number,
  opts: ExtraOptions = {},
  types: DiscoveredType[] = [["string", undefined]],
): CollectedTypeEntry => ["t.ts", pos, types, opts];

describe("buildCstReplacements", () => {
  it("emits a `: T` insertion at a param site", () => {
    const src = "function f(a) {}";
    const pos = src.indexOf("(a") + 2; // a.name.end
    const reps = build(src, [entry(pos)]);
    expect(reps).toHaveLength(1);
    expect(reps[0].start).toBe(pos);
    expect(reps[0].text).toBe(": string");
  });

  it("counts emitted into telemetry when verify is off", () => {
    const src = "function f(a) {}";
    const pos = src.indexOf("(a") + 2;
    const telemetry = {
      totalEntries: 0,
      emitted: 0,
      idempotent: 0,
      unparseable: 0,
      positionMismatch: 0,
      verifyReject: 0,
    };
    build(src, [entry(pos)], emptyCtx({ telemetry }));
    expect(telemetry.emitted).toBe(1);
  });

  it("applies the emission prefix", () => {
    const src = "function f(a) {}";
    const pos = src.indexOf("(a") + 2;
    const reps = build(src, [entry(pos)], emptyCtx({ prefix: "import('./t')." }));
    expect(reps[0].text).toBe(": import('./t').string");
  });

  it("skips a varDecl whose RHS carries an `as` cast when honorAsCasts is on", () => {
    const src = "const x = foo as Bar;";
    const pos = src.indexOf("x") + 1;
    const reps = build(src, [entry(pos, { varDecl: true, hasAsCast: true })]);
    expect(reps).toHaveLength(0);
  });

  it("wraps a paren-less single-param arrow with () around the annotation", () => {
    const src = "const f = a => a;";
    const pos = src.indexOf("a =>") + 1; // a.name.end
    const reps = build(src, [entry(pos)]);
    // Expect three inserts: `(` open, `)` close, and the `: string` annotation.
    const texts = reps.map((r) => r.text).sort();
    expect(texts).toContain("(");
    expect(texts).toContain(")");
    expect(reps.some((r) => r.text === ": string")).toBe(true);
  });
});
