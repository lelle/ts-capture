// @ts-capture Node CJS preload for type instrumentation without Babel or
// Vite. Activate via:
//   NODE_OPTIONS='--require @ts-capture/core/preload'
//
// Installs `globalThis.__tscptr__` and writes per-process JSON dumps. See
// `./runtime-shared.ts` for the configuration env vars and behavior.
import { installTsCaptureRuntime } from "./runtime-shared.js";

installTsCaptureRuntime();
