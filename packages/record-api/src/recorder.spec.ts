import type { AddressInfo } from "node:net";

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRecorder } from "./recorder.js";

// A service with no contract: all we know of it is what it answers.
const RESPONSES: Record<string, string> = {
  "/orders/o-1": JSON.stringify({
    id: "o-1",
    status: "paid",
    customer: { id: 7, name: "Ada" },
    lines: [{ sku: "chair", qty: 2, price: 120 }],
    shippedAt: null,
  }),
  "/orders/o-2": JSON.stringify({
    id: "o-2",
    status: "shipped",
    customer: { id: 9, name: "Bo", email: "bo@example.com" },
    lines: [{ sku: "lamp", qty: 1, price: 45, note: "gift wrap" }],
    shippedAt: "2026-11-01T10:00:00Z",
  }),
  "/orders": JSON.stringify([{ id: "o-1", status: "paid" }]),
  "/health": "ok",
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = RESPONSES[request.url ?? ""];
    response.statusCode = body === undefined ? 404 : 200;
    response.end(body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("createRecorder", () => {
  it("writes the type the responses show, with what only some have as optional", async () => {
    const { recorded, source } = createRecorder();
    await recorded("getOrder", fetch(`${base}/orders/o-1`));
    await recorded("getOrder", fetch(`${base}/orders/o-2`));

    expect(source()).toBe(
      "export type GetOrder = { customer: { email?: string; id: number; name: string }; id: string; lines: { note?: string; price: number; qty: number; sku: string }[]; shippedAt: string | null; status: string };\n",
    );
  });

  it("hands the response back unread, so the caller reads it as before", async () => {
    const { recorded } = createRecorder();
    const response = await recorded("getOrder", fetch(`${base}/orders/o-1`));

    expect(((await response.json()) as { id: string }).id).toBe("o-1");
  });

  it("writes one type per name, in name order", async () => {
    const { recorded, source } = createRecorder();
    await recorded("listOrders", fetch(`${base}/orders`));
    await recorded("getOrder", fetch(`${base}/orders/o-1`));

    expect(
      source()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" =")[0]),
    ).toEqual(["export type GetOrder", "export type ListOrders"]);
  });

  it("leaves out a response that is not JSON", async () => {
    const { recorded, source } = createRecorder();
    await recorded("health", fetch(`${base}/health`));

    expect(source()).toBe("");
  });

  it("writes nothing before a response is recorded", () => {
    expect(createRecorder().source()).toBe("");
  });

  it("refuses a name that cannot be a type's", async () => {
    const { recorded } = createRecorder();

    await expect(
      recorded("GET /orders/:id", fetch(`${base}/orders/o-1`)),
    ).rejects.toThrow('cannot name a type: "GET /orders/:id"');
  });
});
