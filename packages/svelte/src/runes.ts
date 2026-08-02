import { snapshot } from "svelte/internal/client";

const PEEK = Symbol.for("ts-capture.peek");

/**
 * Attach the ts-capture peek protocol (`Symbol.for("ts-capture.peek")`) to a
 * Svelte 5 `$state` proxy so ts-capture's type walker calls `snapshot()` and
 * observes the unwrapped plain value instead of the reactive proxy.
 *
 * For `$state({...})` objects observed **outside** reactive effects, ts-capture
 * already walks them correctly without this helper — property reads on a Svelte
 * proxy outside an `$effect` do not register subscriptions. Use `attachPeek`
 * when observation may happen inside an effect context and you want to guarantee
 * no reactivity side-effects.
 *
 * Usage in a component:
 * ```ts
 * import { attachPeek } from "@ts-capture/svelte/runes";
 * let profile = attachPeek($state({ name: "alice", age: 30 }));
 * ```
 *
 * Implementation note: uses `svelte/internal/client.snapshot`, which is
 * Svelte's internal runtime API (not public). If Svelte exposes
 * `snapshot` as a public import in a future version, this can be
 * replaced.
 */
export function attachPeek<T extends object>(value: T): T {
  (value as Record<symbol, unknown>)[PEEK] = (): T => snapshot(value);
  return value;
}
