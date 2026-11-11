import type { RunMessage, RunRequest } from "./messages.js";

import {
  fromPlaygroundOptions,
  type PlaygroundResult,
  runPlayground,
  typesFromJson,
} from "./run.js";

const libs: Promise<Map<string, string>> = fetch(
  new URL("libs.json", self.location.href),
)
  .then((response) => response.json() as Promise<Array<[string, string]>>)
  .then((entries) => new Map(entries));

const send = (message: RunMessage): void => self.postMessage(message);

self.onmessage = async (event: MessageEvent<RunRequest>) => {
  const { id, code, kind, json, options } = event.data;
  let result: PlaygroundResult;
  try {
    const loaded = await libs;
    send({ id, type: "started" });
    result =
      kind === "json"
        ? typesFromJson(code, { ...json, ...fromPlaygroundOptions(options) })
        : await runPlayground(code, loaded, fromPlaygroundOptions(options));
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  send({ id, type: "done", result });
};
