import tsCapture from "@ts-capture/vite";
import { defineConfig } from "vite";

import { orderApi } from "./server/order-api.ts";

export default defineConfig({
  plugins: [orderApi(), tsCapture({ outputFile: "types.json" })],
});
