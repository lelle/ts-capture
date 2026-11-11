import type { RunMessage, RunRequest } from "./messages.js";
import type { PlaygroundResult } from "./run.js";

import { setUpControls } from "./controls.js";

const TIMEOUT_MS = 10_000;
const stacked = matchMedia("(max-width: 760px)");
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");

const code = document.querySelector<HTMLTextAreaElement>("#code")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector<HTMLElement>("#status")!;
const output = document.querySelector<HTMLElement>("#result")!;
const report = document.querySelector<HTMLElement>("#report")!;

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

const controls = setUpControls(() => {
  clear();
  say("");
});

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
    kind: controls.kind(),
    json: controls.json(),
    options: controls.options(),
  };
  worker.postMessage(request);
}

button.addEventListener("click", run);
code.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) run();
});
