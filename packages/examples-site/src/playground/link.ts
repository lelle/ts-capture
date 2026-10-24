import {
  changedOptions,
  OPTION_DEFAULTS,
  OUTPUT_MODES,
  type PlaygroundOptions,
} from "./options.js";

const isOption = (key: string): key is keyof PlaygroundOptions =>
  Object.hasOwn(OPTION_DEFAULTS, key);

/**
 * `#code=<encoded>`, then `&infer.<key>=<value>` for each option that is not
 * the default; undefined when an option is one the playground cannot set.
 */
export function playgroundLink(
  code: string,
  options: Record<string, unknown>,
): string | undefined {
  if (!Object.keys(options).every(isOption)) return undefined;
  const changed = changedOptions({ ...OPTION_DEFAULTS, ...options });
  return [
    `#code=${encodeURIComponent(code)}`,
    ...Object.entries(changed).map(([key, value]) => `infer.${key}=${value}`),
  ].join("&");
}

function optionValue<K extends keyof PlaygroundOptions>(
  key: K,
  text: string,
): PlaygroundOptions[K] | undefined {
  const value: unknown =
    typeof OPTION_DEFAULTS[key] === "boolean"
      ? { true: true, false: false }[text]
      : OUTPUT_MODES.find((mode) => mode === text);
  return value as PlaygroundOptions[K] | undefined;
}

/** What a link to the playground carries; undefined when it carries no code. */
export function linkFromHash(
  hash: string,
): { code: string; options: Partial<PlaygroundOptions> } | undefined {
  const [first = "", ...rest] = hash.split("&");
  const match = /^#code=(.*)$/s.exec(first);
  if (!match) return undefined;
  let code: string;
  try {
    code = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  const options: Record<string, unknown> = {};
  for (const pair of rest) {
    const [, key = "", text = ""] = /^infer\.([^=]+)=(.*)$/.exec(pair) ?? [];
    const value = isOption(key) ? optionValue(key, text) : undefined;
    if (value !== undefined) options[key] = value;
  }
  return { code, options };
}
