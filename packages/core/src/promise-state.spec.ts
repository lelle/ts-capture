import { describe, expect, it } from "vitest";

import { createCollectionContextWith } from "./collection-context.js";
import { createTrackedPromiseState } from "./promise-state.js";

describe("createTrackedPromiseState", () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const observe = async (ctx: ReturnType<typeof createCollectionContextWith>) => {
    ctx.settlePromises();
    await settle();
    ctx.settlePromises();
    await settle();
  };
  const typeAt = (ctx: ReturnType<typeof createCollectionContextWith>, pos: number) =>
    ctx.getCollectedTypes().find((e) => e[1] === pos)?.[2][0][0];

  it("reports a promise as pending until it has been seen to settle", async () => {
    const read = createTrackedPromiseState();
    const fulfilled = Promise.resolve(1);
    const rejected = Promise.reject(new Error("boom"));
    const pending = new Promise<number>(() => {});
    expect([read(fulfilled), read(rejected), read(pending)]).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    await settle();
    expect([read(fulfilled), read(rejected), read(pending)]).toEqual([
      "fulfilled",
      "rejected",
      "pending",
    ]);
  });

  it("lets a context record a returned promise without node:util", async () => {
    const ctx = createCollectionContextWith(createTrackedPromiseState());
    ctx.record("(return)", Promise.resolve("x"), 10, "f.ts", { returnType: true });
    ctx.record("(return)", Promise.reject(new Error("boom")), 20, "f.ts", { returnType: true });
    await observe(ctx);
    expect(typeAt(ctx, 10)).toBe("Promise<string>");
    expect(typeAt(ctx, 20)).toBeUndefined();
  });
});
