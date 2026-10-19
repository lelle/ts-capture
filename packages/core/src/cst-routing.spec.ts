import { describe, expect, it } from "vitest";

import type { DiscoveredType } from "./collector-contract.js";
import type { CstSiteIndex, VarDeclSite } from "./cst-site-index.js";
import type { CollectedTypeEntry, CollectedTypeInfo, ExtraOptions } from "./type-collector.js";

import { INFER_DEFAULTS } from "./configuration.js";
import { newApplyTelemetry } from "./contract.js";
import { routeEntries } from "./cst-routing.js";

// Direct specs for entry routing. The
// skip guards (rhsIsFunction, generic context, union-producing / opaque
// initializers, existing-type idempotency) were previously only reachable
// through a full applyTypesToFileCst round-trip; here each is probed with a
// hand-built index and a single entry.

function emptyIndex(): CstSiteIndex {
  return {
    paramSites: new Map(),
    typedParamEnds: new Set(),
    thisTypeSites: new Map(),
    returnTypeSites: new Map(),
    varDeclSites: new Map(),
    arrayCallbackArrowParams: new Set(),
    ignoredRanges: [],
  };
}

function varDeclSite(over: Partial<VarDeclSite> = {}): VarDeclSite {
  return {
    hasType: false,
    rhsIsFunction: false,
    initializer: undefined,
    narrowsLiterals: false,
    hasInitializerTypeArguments: false,
    inGenericContext: false,
    isUnionProducingInitializer: false,
    hasOpaqueInitializer: false,
    ...over,
  };
}

function entry(
  pos: number,
  opts: ExtraOptions = {},
  types: DiscoveredType[] = [["string", undefined]],
): CollectedTypeEntry {
  return ["f.ts", pos, types, opts];
}

const route = (
  typeInfo: CollectedTypeInfo,
  index: CstSiteIndex,
  infer = INFER_DEFAULTS,
  tel?: any,
) => routeEntries(typeInfo, index, infer, tel);

describe("routeEntries", () => {
  it("records an entry with no matching site as a no-site skip", () => {
    const tel = newApplyTelemetry();
    const { eligible } = route([entry(10)], emptyIndex(), INFER_DEFAULTS, tel);
    expect(eligible.size).toBe(0);
    expect(tel.skipped).toEqual([{ pos: 10, reason: "no-site", observed: "string" }]);
    expect(tel.positionMismatch).toBe(1);
  });

  it("classifies a plain param entry as CST-eligible", () => {
    const idx = emptyIndex();
    idx.paramSites.set(10, { node: {} as any });
    const { eligible } = route([entry(10)], idx);
    expect([...eligible.values()][0].kind).toBe("param");
  });

  it("routes thisType entries by thisTypeSites presence", () => {
    const idx = emptyIndex();
    idx.thisTypeSites.set(10, { hasOtherParams: false, node: { parameters: [] } as any });
    expect([...route([entry(10, { thisType: true })], idx).eligible.values()][0].kind).toBe(
      "thisType",
    );
    const tel = newApplyTelemetry();
    route([entry(99, { thisType: true })], idx, INFER_DEFAULTS, tel);
    expect(tel.skipped).toEqual([expect.objectContaining({ pos: 99, reason: "no-site" })]);
  });

  it("drops a position inside an ignored range entirely", () => {
    const idx = emptyIndex();
    idx.ignoredRanges.push([5, 20]);
    idx.paramSites.set(10, { node: {} as any });
    const { eligible } = route([entry(10)], idx);
    expect(eligible.size).toBe(0);
  });

  describe("varDecl skip guards (all drop the entry, no pass-through)", () => {
    const cases: Array<[string, VarDeclSite, DiscoveredType[]?]> = [
      ["rhsIsFunction", varDeclSite({ rhsIsFunction: true })],
      ["hasInitializerTypeArguments", varDeclSite({ hasInitializerTypeArguments: true })],
      ["inGenericContext", varDeclSite({ inGenericContext: true })],
      ["union-producing + single type", varDeclSite({ isUnionProducingInitializer: true })],
      [
        "opaque + sole undefined",
        varDeclSite({ hasOpaqueInitializer: true }),
        [["undefined", undefined]],
      ],
    ];
    cases.forEach(([label, site, types]) => {
      it(label, () => {
        const idx = emptyIndex();
        idx.varDeclSites.set(10, site);
        const { eligible } = route([entry(10, { varDecl: true }, types)], idx);
        expect(eligible.size).toBe(0);
      });
    });

    it("union-producing does NOT skip when more than one type observed", () => {
      const idx = emptyIndex();
      idx.varDeclSites.set(10, varDeclSite({ isUnionProducingInitializer: true }));
      const types: DiscoveredType[] = [
        ["string", undefined],
        ["number", undefined],
      ];
      const { eligible } = route([entry(10, { varDecl: true }, types)], idx);
      expect([...eligible.values()][0].kind).toBe("varDecl");
    });
  });

  it("skips already-typed varDecl as idempotent unless ignoreExistingTypes", () => {
    const idx = emptyIndex();
    idx.varDeclSites.set(10, varDeclSite({ hasType: true }));
    const tel = newApplyTelemetry();
    const { eligible } = route([entry(10, { varDecl: true })], idx, INFER_DEFAULTS, tel);
    expect(eligible.size).toBe(0);
    expect(tel.idempotent).toBe(1);
    expect(tel.totalEntries).toBe(1);
    expect(tel.skipped).toEqual([{ pos: 10, reason: "already-annotated", observed: "string" }]);

    const on = { ...INFER_DEFAULTS, ignoreExistingTypes: true };
    expect([...route([entry(10, { varDecl: true })], idx, on).eligible.values()][0].kind).toBe(
      "varDecl",
    );
  });

  it("skips already-typed returnType as idempotent", () => {
    const idx = emptyIndex();
    idx.returnTypeSites.set(10, { hasReturnType: true });
    const { eligible } = route([entry(10, { returnType: true })], idx);
    expect(eligible.size).toBe(0);
  });

  it("drops an observation of a typed position, even with ignoreExistingTypes", () => {
    const idx = emptyIndex();
    idx.paramSites.set(10, { node: {} as any });
    idx.returnTypeSites.set(20, { hasReturnType: true });
    const on = { ...INFER_DEFAULTS, ignoreExistingTypes: true };
    const { eligible } = route(
      [entry(10, { annotated: true }), entry(20, { returnType: true, annotated: true })],
      idx,
      on,
    );
    expect(eligible.size).toBe(0);
  });

  it("dedups entries with the same (file, pos, opts), merging their types", () => {
    const idx = emptyIndex();
    idx.paramSites.set(10, { node: {} as any });
    const { eligible } = route(
      [entry(10, {}, [["string", undefined]]), entry(10, {}, [["number", undefined]])],
      idx,
    );
    expect(eligible.size).toBe(1);
    expect([...eligible.values()][0].entry[2]).toHaveLength(2);
  });
});
