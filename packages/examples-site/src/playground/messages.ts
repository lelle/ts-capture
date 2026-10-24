import type { PlaygroundOptions } from "./options.js";
import type { PlaygroundResult } from "./run.js";

export interface RunRequest {
  id: number;
  code: string;
  options: PlaygroundOptions;
}

/** `started` is sent once the compiler is loaded, just before the code runs. */
export type RunMessage =
  | { id: number; type: "started" }
  | { id: number; type: "done"; result: PlaygroundResult };
