import type { ProjectVerificationContext } from "@ts-capture/core";

import { registerVirtualFile } from "@ts-capture/core";
import path from "node:path";

/**
 * Synthetic ambient declaring Svelte 5 runes as globals.
 *
 * `.svelte` script blocks are verified as isolated standalone TS files
 * (core's `registerVirtualFile`). In that context `$state` / `$props` /
 * `$derived` etc. are unresolved — each would surface a "Cannot find
 * name" diagnostic. The diff-based verifier keys diagnostics on
 * `file:start:code`, so a non-empty baseline whose positions shift under
 * an inserted annotation reads as "new errors" and rejects sound
 * candidates. Declaring the runes as ambient globals keeps the block's
 * baseline clean, so only annotation-introduced diagnostics count.
 *
 * This is Svelte-specific knowledge and intentionally lives in the
 * adapter package, not core — core only provides the generic
 * `registerVirtualFile` primitive this builds on.
 *
 * Loose return types are deliberate: verification only asks whether a
 * candidate annotation introduces a NEW diagnostic, not whether the rune
 * types are exact.
 */
const RUNES_AMBIENT_FILENAME = "__tscapture_svelte_runes__.d.ts";
const RUNES_AMBIENT_SOURCE = [
  "declare function $state<T>(initial?: T): T;",
  "declare namespace $state {",
  "  export function raw<T>(initial?: T): T;",
  "  export function snapshot<T>(value: T): T;",
  "}",
  "declare function $derived<T>(expression: T): T;",
  "declare namespace $derived {",
  "  export function by<T>(fn: () => T): T;",
  "}",
  "declare function $props<T = Record<string, any>>(): T;",
  "declare function $bindable<T>(fallback?: T): T;",
  "declare function $effect(fn: () => void | (() => void)): void;",
  "declare namespace $effect {",
  "  export function pre(fn: () => void | (() => void)): void;",
  "  export function root(fn: () => void | (() => void)): () => void;",
  "  export function tracking(): boolean;",
  "}",
  "declare function $inspect<T extends unknown[]>(...values: T): {",
  "  with: (fn: (type: 'init' | 'update', ...values: T) => void) => void;",
  "};",
  "declare function $host<El extends EventTarget = HTMLElement>(): El;",
  "",
].join("\n");

// Per-project idempotency: register the ambient once per verification
// context, not once per block.
const ambientRegistered = new WeakSet<ProjectVerificationContext>();

/**
 * Register the Svelte runes ambient into a project verification
 * context, once. Safe to call before verifying every `.svelte` block.
 */
export function registerRunesAmbient(
  project: ProjectVerificationContext,
): void {
  if (ambientRegistered.has(project)) return;
  const ambientPath = path.join(project.rootDir, RUNES_AMBIENT_FILENAME);
  registerVirtualFile(project, ambientPath, RUNES_AMBIENT_SOURCE);
  ambientRegistered.add(project);
}
