import type { PlaygroundOptions } from "./options.js";
import type { PlaygroundResult } from "./run.js";
import type { Kind } from "./starters.js";

export interface RunRequest {
  id: number;
  code: string;
  /** `json`: `code` is a value to type, not code to run. */
  kind: Kind;
  /** For `json`: what the value is called, and how deep it is read (core's default when unset). */
  json: { name: string; maxDepth?: number };
  options: PlaygroundOptions;
}

/** `started` is sent once the compiler is loaded, just before the code runs. */
export type RunMessage =
  | { id: number; type: "started" }
  | { id: number; type: "done"; result: PlaygroundResult };
