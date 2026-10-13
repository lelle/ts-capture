import { defineConfig } from "vite";

import { orderApi } from "./server/order-api.ts";

export default defineConfig({
  plugins: [orderApi()],
});
