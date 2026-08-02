/**
 * Node.js register entry point for ts-capture.
 *
 * Usage:
 *   node --import @ts-capture/core/register src/main.ts
 *
 * This module:
 * 1. Registers a module loader hook that instruments .ts/.tsx files
 * 2. Sets up a global __tscptr__ collection context
 * 3. On process exit, applies collected types back to source files
 */

import { register } from "node:module";

// `register` is flagged @deprecated by recent @types/node in favour of
// `module.registerHooks`, but we keep it deliberately: registerHooks needs
// Node >=22.15 (this package supports Node >=20) and runs hooks synchronously
// in-thread, whereas our `./loader.js` is an out-of-thread async ESM loader.
// Switching would drop the supported-Node floor and require rewriting the
// loader. Keep this rationale beside the deprecated call so it remains visible.
register("./loader.js", import.meta.url);
