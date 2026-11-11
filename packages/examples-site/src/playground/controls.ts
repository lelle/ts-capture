import type { RunRequest } from "./messages.js";
import type { Kind, Starter } from "./starters.js";

import { linkFromHash, starterFromHash } from "./link.js";
import {
  changedOptions,
  changedSummary,
  OPTION_DEFAULTS,
  type PlaygroundOptions,
  SWITCHES,
} from "./options.js";

export interface Controls {
  /** Whether the editor holds code to run or JSON to type. */
  kind(): Kind;
  options(): PlaygroundOptions;
  /** What the JSON is called, and how deep it is read. */
  json(): RunRequest["json"];
}

/**
 * The playground's starter, options and JSON fields, opened from the link the
 * page came from. `chosen` runs when a visitor picks another starter.
 */
export function setUpControls(chosen: () => void): Controls {
  const code = document.querySelector<HTMLTextAreaElement>("#code")!;
  const starter = document.querySelector<HTMLSelectElement>("#starter")!;
  const optionsPart = document.querySelector<HTMLDetailsElement>(".options")!;
  const changed = document.querySelector<HTMLElement>("#changed")!;
  const switches = SWITCHES.map(
    ({ key }) =>
      [
        key,
        document.getElementById(`infer-${key}`) as HTMLInputElement,
      ] as const,
  );
  const modes = [
    ...document.querySelectorAll<HTMLInputElement>('input[name="outputMode"]'),
  ];
  const rootName = document.querySelector<HTMLInputElement>("#root-name")!;
  const maxDepth = document.querySelector<HTMLInputElement>("#max-depth")!;
  const kindWords = [...document.querySelectorAll<HTMLElement>("[data-kind]")];
  const starters = JSON.parse(
    document.querySelector("#starters")!.textContent,
  ) as Starter[];

  // A browser that restores the form after a reload restores the select too.
  let kind: Kind =
    starters.find((candidate) => candidate.id === starter.value)?.kind ??
    "code";

  function options(): PlaygroundOptions {
    const read = { ...OPTION_DEFAULTS };
    for (const [key, box] of switches) read[key] = box.checked;
    const mode = modes.find((candidate) => candidate.checked)?.value;
    if (mode) read.outputMode = mode as PlaygroundOptions["outputMode"];
    return read;
  }

  function countChanged(): void {
    changed.textContent = changedSummary(
      Object.keys(changedOptions(options())).length,
    );
  }

  function setOptions(chosenOptions: Partial<PlaygroundOptions>): void {
    const all = { ...OPTION_DEFAULTS, ...chosenOptions };
    for (const [key, box] of switches) box.checked = all[key];
    for (const mode of modes) mode.checked = mode.value === all.outputMode;
    countChanged();
  }

  function setKind(next: Kind): void {
    kind = next;
    for (const words of kindWords) words.hidden = words.dataset.kind !== kind;
  }

  function choose(id: string): boolean {
    const picked = starters.find((candidate) => candidate.id === id);
    if (!picked) return false;
    starter.value = picked.id;
    code.value = picked.code;
    setKind(picked.kind ?? "code");
    setOptions(picked.options ?? {});
    return true;
  }

  setKind(kind);
  optionsPart.addEventListener("change", countChanged);
  starter.addEventListener("change", () => {
    if (!choose(starter.value)) return;
    chosen();
    // The link that opened the page no longer says what is on it.
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  });

  // A link from another page (how it decides) brings its own code and options.
  const linked = linkFromHash(window.location.hash);
  if (linked !== undefined) {
    code.value = linked.code;
    starter.value = "";
    setKind("code");
    setOptions(linked.options);
  }
  const linkedStarter = starterFromHash(window.location.hash);
  if (linkedStarter !== undefined) choose(linkedStarter);

  return {
    kind: () => kind,
    options,
    json: () => ({
      name: rootName.value.trim(),
      maxDepth:
        maxDepth.valueAsNumber >= 1 ? maxDepth.valueAsNumber : undefined,
    }),
  };
}
