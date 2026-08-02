// @ts-capture setupFile-compatible runtime initializer.
//
// Use when the NODE_OPTIONS preload path doesn't reach into your test
// runner's sandboxed contexts. Most common case: Jest with
// `jest-environment-jsdom` (or `jest-fixed-jsdom`), where each test file
// gets a fresh V8 vm context whose `globalThis` is the jsdom `window` —
// Node process globals don't leak in.
//
// Usage:
//   // jest.config.js
//   module.exports = {
//     setupFilesAfterEnv: ['<rootDir>/ts-capture-setup.js'],
//   };
//
//   // ts-capture-setup.js
//   require('@ts-capture/core/setup');
//
// Idempotent: Jest re-evaluates setupFilesAfterEnv per test file, but
// `globalThis` is shared across files in the same worker — the Symbol
// guard in `./runtime-shared.ts` avoids replacing an existing ctx closure
// with a fresh one, which would orphan observations from earlier files.
import { installTsCaptureRuntime } from "./runtime-shared.js";

installTsCaptureRuntime();
