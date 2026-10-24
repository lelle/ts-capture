import type { RunMessage, RunRequest } from "./messages.js";
import type { PlaygroundResult } from "./run.js";
import type { Starter } from "./starters.js";

import { linkFromHash } from "./link.js";
import {
  changedOptions,
  changedSummary,
  OPTION_DEFAULTS,
  type PlaygroundOptions,
  SWITCHES,
} from "./options.js";

const TIMEOUT_MS = 10_000;
const stacked = matchMedia("(max-width: 760px)");
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");

const code = document.querySelector<HTMLTextAreaElement>("#code")!;
const starter = document.querySelector<HTMLSelectElement>("#starter")!;
const optionsPart = document.querySelector<HTMLDetailsElement>(".options")!;
const changed = document.querySelector<HTMLElement>("#changed")!;
const switches = SWITCHES.map(
  ({ key }) =>
    [key, document.querySelector<HTMLInputElement>(`#infer-${key}`)!] as const,
);
const modes = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="outputMode"]'),
];
const button = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector<HTMLElement>("#status")!;
const output = document.querySelector<HTMLElement>("#result")!;
const report = document.querySelector<HTMLElement>("#report")!;
const starters = JSON.parse(
  document.querySelector("#starters")!.textContent,
) as Starter[];

let worker: Worker | undefined;
let current = 0;
let timer: number | undefined;

function say(text: string, failed = false): void {
  status.textContent = text;
  status.classList.toggle("failed", failed);
}

function clear(): void {
  output.textContent = "";
  report.textContent = "";
}

function readOptions(): PlaygroundOptions {
  const options = { ...OPTION_DEFAULTS };
  for (const [key, box] of switches) options[key] = box.checked;
  const mode = modes.find((candidate) => candidate.checked)?.value;
  if (mode) options.outputMode = mode as PlaygroundOptions["outputMode"];
  return options;
}

function countChanged(): void {
  changed.textContent = changedSummary(
    Object.keys(changedOptions(readOptions())).length,
  );
}

function setOptions(options: Partial<PlaygroundOptions>): void {
  const all = { ...OPTION_DEFAULTS, ...options };
  for (const [key, box] of switches) box.checked = all[key];
  for (const mode of modes) mode.checked = mode.value === all.outputMode;
  countChanged();
}

function finish(): void {
  window.clearTimeout(timer);
  button.disabled = false;
}

function discardWorker(): void {
  worker?.terminate();
  worker = undefined;
}

function show(result: PlaygroundResult): void {
  if (!result.ok) {
    clear();
    say(`The code did not run: ${result.error}`, true);
    return;
  }
  output.innerHTML = result.html;
  report.textContent = [...result.summary, ...result.report].join("\n");
  say("");
  // Stacked under the editor, the result is off screen when it arrives.
  if (stacked.matches) {
    output.closest("figure")!.scrollIntoView({
      behavior: stillMotion.matches ? "auto" : "smooth",
      block: "start",
    });
  }
}

function startWorker(): Worker {
  const started = new Worker("worker.js");
  started.onmessage = (event: MessageEvent<RunMessage>) => {
    const message = event.data;
    if (message.id !== current) return;
    if (message.type === "started") {
      say("Running…");
      timer = window.setTimeout(() => {
        discardWorker();
        finish();
        clear();
        say("Stopped after 10 seconds. Is there a loop that never ends?", true);
      }, TIMEOUT_MS);
      return;
    }
    finish();
    show(message.result);
  };
  started.onerror = () => {
    discardWorker();
    finish();
    say("The playground could not start. Reload the page to try again.", true);
  };
  return started;
}

function run(): void {
  if (button.disabled) return;
  current += 1;
  button.disabled = true;
  say(worker ? "Running…" : "Loading the TypeScript compiler…");
  worker ??= startWorker();
  const request: RunRequest = {
    id: current,
    code: code.value,
    options: readOptions(),
  };
  worker.postMessage(request);
}

button.addEventListener("click", run);
code.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) run();
});
optionsPart.addEventListener("change", countChanged);
// A link from another page (how it decides) brings its own code and options.
const linked = linkFromHash(window.location.hash);
if (linked !== undefined) {
  code.value = linked.code;
  starter.value = "";
  setOptions(linked.options);
}

starter.addEventListener("change", () => {
  const chosen = starters.find((candidate) => candidate.id === starter.value);
  if (!chosen) return;
  code.value = chosen.code;
  setOptions(chosen.options ?? {});
  clear();
  say("");
});
