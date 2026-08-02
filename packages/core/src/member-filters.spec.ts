import { describe, expect, it } from "vitest";

import { applyMemberFilters, type Priority, type UnconditionalFilter } from "./member-filters.js";

describe("member-filters", () => {
  it("unconditional drops every matching member", () => {
    const filters: UnconditionalFilter[] = [{ name: "drop foo", drop: (t) => t === "foo" }];
    expect(applyMemberFilters(["foo", "bar", "foo"], filters, [])).toEqual(["bar"]);
  });

  it("Priority drops low only when high is present", () => {
    const priorities: Priority[] = [
      { name: "concrete vs unknown", high: (t) => t === "string", low: (t) => t === "unknown" },
    ];
    // High present → low dropped.
    expect(applyMemberFilters(["string", "unknown"], [], priorities)).toEqual(["string"]);
    // High absent → low kept.
    expect(applyMemberFilters(["unknown"], [], priorities)).toEqual(["unknown"]);
  });

  it("Priorities apply in order; later priority sees post-earlier-priority state", () => {
    const priorities: Priority[] = [
      { name: "drop foo when bar", high: (t) => t === "bar", low: (t) => t === "foo" },
      { name: "drop bar when baz", high: (t) => t === "baz", low: (t) => t === "bar" },
    ];
    // After priority 1: [bar, baz]. After priority 2: [baz].
    expect(applyMemberFilters(["foo", "bar", "baz"], [], priorities)).toEqual(["baz"]);
  });

  it("unconditional filters run before priorities", () => {
    // If "high" is unconditionally dropped first, the priority shouldn't fire.
    const filters: UnconditionalFilter[] = [{ name: "drop string", drop: (t) => t === "string" }];
    const priorities: Priority[] = [
      { name: "concrete vs unknown", high: (t) => t === "string", low: (t) => t === "unknown" },
    ];
    // After unconditional: [unknown]. Priority: no high → unknown kept.
    expect(applyMemberFilters(["string", "unknown"], filters, priorities)).toEqual(["unknown"]);
  });

  it("empty input → empty output", () => {
    expect(applyMemberFilters([], [], [])).toEqual([]);
  });

  it("no filters / no priorities → identity (copy)", () => {
    const input = ["a", "b", "c"];
    const out = applyMemberFilters(input, [], []);
    expect(out).toEqual(input);
    expect(out).not.toBe(input); // returned a new array
  });

  it("priority that matches no member is a no-op", () => {
    const priorities: Priority[] = [{ name: "noop", high: () => false, low: () => true }];
    expect(applyMemberFilters(["a", "b"], [], priorities)).toEqual(["a", "b"]);
  });
});
