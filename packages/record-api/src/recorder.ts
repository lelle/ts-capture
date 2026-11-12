import { typesFromValues } from "@ts-capture/core";

export interface Recorder {
  /** Keeps the response's JSON under `name`, and hands the response back unread. */
  recorded(
    name: string,
    response: Promise<Response> | Response,
  ): Promise<Response>;
  /** One `export type` per name, from every response recorded under it. */
  source(): string;
}

/** Records what a service answers, and writes the types its answers show. */
export function createRecorder(): Recorder {
  const samples = new Map<string, unknown[]>();

  async function recorded(
    name: string,
    response: Promise<Response> | Response,
  ): Promise<Response> {
    const answered = await response;
    if (typesFromValues([], { name }).rootName === undefined) {
      throw new Error(`cannot name a type: ${JSON.stringify(name)}`);
    }
    try {
      const value: unknown = await answered.clone().json();
      samples.set(name, [...(samples.get(name) ?? []), value]);
    } catch {
      // Not JSON: there is no value to type.
    }
    return answered;
  }

  function source(): string {
    return [...samples]
      .map(([name, values]) => typesFromValues(values, { name }))
      .filter((result) => result.type !== undefined)
      .sort((a, b) => a.rootName!.localeCompare(b.rootName!))
      .map(({ rootName, type }) => `export type ${rootName} = ${type};\n`)
      .join("");
  }

  return { recorded, source };
}
