# @ts-capture/record-api

A reference, not a published package: how to type a service that comes with
no contract. Record what it answers, and write the types its answers show.

```ts
import { createRecorder } from "./recorder.js";

const { recorded, source } = createRecorder();

export const getOrder = (id: string) =>
  recorded("getOrder", fetch(`https://shop.example/orders/${id}`));

// after the run, e.g. in a test's afterAll:
writeFileSync("src/api-types.ts", source());
```

```ts title="src/api-types.ts"
export type GetOrder = {
  customer: { email?: string; id: number; name: string };
  id: string;
  lines: { note?: string; price: number; qty: number; sku: string }[];
  shippedAt: string | null;
  status: string;
};
```

Each type is what `typesFromValues` from `@ts-capture/core` gives for every
response recorded under its name: the type `ts-capture apply` would write for a
parameter called with them. A field only some responses have is optional, and
one that is sometimes `null` is `| null`.

- **A type is only as wide as the responses seen.** Run the calls that bring
  the variants (an unshipped order, a customer without email) in the same run;
  a narrower type next time shows in the diff.
- **Names are type names.** `getOrder` becomes `GetOrder`; a name that cannot
  be one (`GET /orders/:id`) is refused.
- **A response that is not JSON is passed on and not recorded.**
- **Nothing is kept between runs,** and no value reaches the file: strings are
  written as `string`.

```sh
pnpm --filter @ts-capture/record-api test
```
