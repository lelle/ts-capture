# Type a service with no contract

Goal: types for a service that comes with no OpenAPI document, no SDK and no
types of its own, taken from what it actually answers. You wrap the calls to
it, run them, and get a file of types you check in.

This is a recipe, not a package: copy the recorder below into your project. It
is kept in the repository as
[`packages/record-api`](../../packages/record-api/), where it is tested
against a local server.

## Record the responses

The recorder keeps the JSON of every response under the name you give the
call, and hands the response back unread, so your code reads it as before:

```ts title="recorder.ts"
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
```

Give each endpoint one name, where your client calls it:

```ts title="shop.ts"
import { createRecorder } from "./recorder.js";

export const recorder = createRecorder();

export const getOrder = (id: string) =>
  recorder.recorded("getOrder", fetch(`https://shop.example/orders/${id}`));
```

The name becomes the type's name: `getOrder` gives `GetOrder`. A name that
cannot be a type's, such as `GET /orders/:id`, is refused.

## Run the calls that bring the variants

A type is only as wide as the responses behind it. Call the service in the
cases that differ: an order that has shipped and one that has not, a customer
with an email address and one without.

```ts title="shop.spec.ts"
import { writeFileSync } from "node:fs";
import { afterAll, it } from "vitest";

import { getOrder, recorder } from "./shop.js";

it("reads a paid and a shipped order", async () => {
  await (await getOrder("o-1")).json();
  await (await getOrder("o-2")).json();
});

afterAll(() => {
  writeFileSync("src/api-types.ts", recorder.source());
});
```

## Check in the types

```ts title="src/api-types.ts"
export type GetOrder = {
  customer: { email?: string; id: number; name: string };
  id: string;
  lines: { note?: string; price: number; qty: number; sku: string }[];
  shippedAt: string | null;
  status: string;
};
```

The second order had a customer email and a note on its line, so those fields
are optional; the first had not shipped, so `shippedAt` may be `null`. Each
type is what [`typesFromValues`](type-a-value.md) gives for the responses
recorded under its name. `source()` writes each type on one line; your
formatter lays it out as above.

Run it again when the service changes. The file is rewritten, so the change
shows in the diff, and so does a field the run did not see this time: a type
can become narrower when fewer variants were called.

## What the recorder leaves out

- **Responses that are not JSON** are passed on and not recorded.
- **Nothing is kept between runs.** Every run writes the types from its own
  responses only.
- **No value reaches the file.** Strings are written as `string`, so a name or
  an email address in a response does not end up in your source.
- **What the service never answered** is not in the type. An error body, or a
  status the run did not call, needs a call of its own.
