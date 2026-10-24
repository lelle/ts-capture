import type { InferOptions } from "@ts-capture/core/browser";

/** The `infer` options the playground lets a visitor set: those a one-file run shows. */
export type PlaygroundOptions = Pick<
  InferOptions,
  | "aliasRepeatedShapes"
  | "narrowParamShapes"
  | "outputMode"
  | "skipRedundantAnnotations"
>;

export type SwitchKey = Exclude<keyof PlaygroundOptions, "outputMode">;

export const SWITCHES: ReadonlyArray<{ key: SwitchKey; label: string }> = [
  { key: "aliasRepeatedShapes", label: "Name repeated shapes" },
  { key: "skipRedundantAnnotations", label: "Skip what TypeScript infers" },
  { key: "narrowParamShapes", label: "Narrow parameter shapes" },
];

export const OUTPUT_MODES: ReadonlyArray<PlaygroundOptions["outputMode"]> = [
  "annotations",
  "comments",
  "both",
];

// Kept apart from INFER_DEFAULTS so the page script does not load core; a spec
// holds the two together.
export const OPTION_DEFAULTS: PlaygroundOptions = {
  aliasRepeatedShapes: false,
  skipRedundantAnnotations: true,
  narrowParamShapes: false,
  outputMode: "annotations",
};

export function changedOptions(
  options: PlaygroundOptions,
): Partial<PlaygroundOptions> {
  return Object.fromEntries(
    Object.entries(options).filter(
      ([key, value]) =>
        OPTION_DEFAULTS[key as keyof PlaygroundOptions] !== value,
    ),
  );
}

export function changedSummary(count: number): string {
  return count === 0 ? "" : `${count} changed from the defaults`;
}
