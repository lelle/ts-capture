import type { Plugin } from "vite";

const PRICES: Record<string, number> = {
  "TEE-BLACK-M": 199,
  "CAP-NAVY-OS": 149,
};

interface OrderBody {
  lines: Array<{ sku: string; qty: number }>;
  payment: string;
  discountCode?: string;
}

/** Stands in for a backend: answers `POST /api/orders` from the dev server. */
export function orderApi(): Plugin {
  let nextId = 2026_1042;
  return {
    name: "demo-order-api",
    configureServer(server) {
      server.middlewares.use("/api/orders", (req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          const order = JSON.parse(body) as OrderBody;
          const sum = order.lines.reduce(
            (total, line) => total + line.qty * PRICES[line.sku],
            0,
          );
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              id: `ORD-${nextId++}`,
              status: order.payment === "card" ? "paid" : "pending",
              total: order.discountCode ? Math.round(sum * 0.9) : sum,
            }),
          );
        });
      });
    },
  };
}
