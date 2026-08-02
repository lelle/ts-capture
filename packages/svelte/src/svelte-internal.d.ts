// Minimal ambient declarations for the Svelte internal runtime API used by
// this package. `svelte/internal/client` is not part of Svelte's public API
// and has no official type declarations. We declare only what we use.
// If Svelte exposes snapshot as a public import in a future version, this
// declaration should be removed and the import updated.
declare module "svelte/internal/client" {
  /**
   * Unwrap a Svelte 5 `$state` reactive proxy to a plain (non-reactive) object.
   * For non-reactive values, returns the value unchanged.
   * This is the runtime implementation of the `$state.snapshot()` rune.
   */
  export function snapshot<T>(value: T): T;
}
