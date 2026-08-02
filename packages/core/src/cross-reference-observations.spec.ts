import { describe, expect, it } from "vitest";

import type { CollectedTypeInfo, ExtraOptions } from "./collector-contract.js";

import { crossReferenceObservations, type CrossRefInput } from "./cross-reference-observations.js";
import { buildFunctionSignature } from "./type-signature.js";

const GENERIC_FN = "(...args: unknown[]) => unknown";

function logKey(filename: string, pos: number, opts: ExtraOptions = {}): string {
  return JSON.stringify({ filename, pos, opts });
}

function typeEntry(typeName: string): string {
  // Mirrors the recorder: the reason slot is omitted when there's no reason,
  // so `reason` parses back as undefined (not null).
  return JSON.stringify([typeName, undefined]);
}

function emptyInput(logs: Map<string, Set<string>>): CrossRefInput {
  return {
    logs,
    paramNames: new Map(),
    recordedFnKeys: new Map(),
    objectMemberFnKeys: new Map(),
  };
}

function find(out: CollectedTypeInfo, filename: string, pos: number) {
  return out.find((e) => e[0] === filename && e[1] === pos);
}

describe("crossReferenceObservations — plain-data engine (no live functions)", () => {
  it("upgrades a generic function value to a recorded registered fn's signature", () => {
    const logs = new Map<string, Set<string>>([
      // The registered fn's return observation builds its signature.
      [logKey("h.ts", 99, { returnType: true }), new Set([typeEntry("number")])],
      // The value observation that recorded the same fn as a generic value.
      [logKey("app.ts", 42, { varDecl: true }), new Set([typeEntry(GENERIC_FN)])],
    ]);
    const input: CrossRefInput = {
      ...emptyInput(logs),
      recordedFnKeys: new Map([[logKey("app.ts", 42, { varDecl: true }), ["h.ts:99"]]]),
    };

    const out = crossReferenceObservations(input);
    const entry = find(out, "app.ts", 42)!;
    const expectedSig = buildFunctionSignature([], ["number"], false);
    expect(entry[2][0][0]).toBe(expectedSig);
    expect(entry[2][0][0]).not.toBe(GENERIC_FN);
    // Upgraded → no implicit generic-fn reason.
    expect(entry[2][0][2]).toBeUndefined();
  });

  it("tags an un-upgraded generic function value with the generic-fn reason", () => {
    const logs = new Map<string, Set<string>>([
      [logKey("app.ts", 42, { varDecl: true }), new Set([typeEntry(GENERIC_FN)])],
    ]);
    const out = crossReferenceObservations(emptyInput(logs));
    const entry = find(out, "app.ts", 42)!;
    expect(entry[2][0][0]).toBe(GENERIC_FN);
    expect(entry[2][0][2]).toBe("generic-fn");
  });

  it("drops paramReturn entries from the output", () => {
    const logs = new Map<string, Set<string>>([
      [
        logKey("app.ts", 42, { paramReturn: true, paramReturnMember: "cb" }),
        new Set([typeEntry("string")]),
      ],
      [logKey("app.ts", 10, { varDecl: true }), new Set([typeEntry("number")])],
    ]);
    const out = crossReferenceObservations(emptyInput(logs));
    expect(find(out, "app.ts", 42)).toBeUndefined();
    expect(find(out, "app.ts", 10)).toBeDefined();
  });

  it("passes a plain (non-function) observation through unchanged", () => {
    const logs = new Map<string, Set<string>>([
      [logKey("app.ts", 7, { varDecl: true }), new Set([typeEntry("number")])],
    ]);
    const out = crossReferenceObservations(emptyInput(logs));
    const entry = find(out, "app.ts", 7)!;
    expect(entry[2][0][0]).toBe("number");
    expect(entry[2][0][2]).toBeUndefined();
  });
});
