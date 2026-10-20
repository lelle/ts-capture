import type { RunMessage, RunRequest } from "./messages.js";

import { type PlaygroundResult, runPlayground } from "./run.js";

const libs: Promise<Map<string, string>> = fetch(
  new URL("libs.json", self.location.href),
)
  .then((response) => response.json() as Promise<Array<[string, string]>>)
  .then((entries) => new Map(entries));

const send = (message: RunMessage): void => self.postMessage(message);

self.onmessage = async (event: MessageEvent<RunRequest>) => {
  const { id, code, nameShapes } = event.data;
  let result: PlaygroundResult;
  try {
    const loaded = await libs;
    send({ id, type: "started" });
    result = await runPlayground(code, loaded, { nameShapes });
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  send({ id, type: "done", result });
};
