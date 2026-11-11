# Type a value or JSON

Goal: get the TypeScript type of a value you already have, such as a parsed
API response, a fixture or an object in a debugger, without instrumenting or
running any code. Nothing in your source changes.

```ts
import { typesFromValues } from "@ts-capture/core";

const order = await response.json();
typesFromValues([order]).type;
// { customer: { name: string }; id: number; lines: { note?: string; qty: number; sku: string }[] }
```

The type is the one `apply` would write for a parameter called with the same
values, so it follows the same rules and the same
[options](../reference/configuration.md). To try it without installing
anything, paste JSON into the
[playground](https://lelle.github.io/ts-capture/playground/#starter=json).

## Several values make one type

Each value in the list counts as one call. A field only some values have
becomes optional, and lists of objects that differ become one shape:

```ts
const events = [
  { type: "click", x: 1, y: 2 },
  { type: "key", key: "a" },
];

typesFromValues(events).type;
// { key?: string; type: string; x?: number; y?: number }

typesFromValues([events]).type;
// { key?: string; type: string; x?: number; y?: number }[]
```

The first call gives the type of one event, the second the type of the list.

## Name the shapes a value repeats

With `infer.aliasRepeatedShapes`, a shape that occurs more than once is
declared once and named, as `apply` does in a file. The
[API reference](../reference/api.md#from-values-typesfromvalues) says where the
names come from.

```ts
const trip = JSON.parse(
  '{"from":{"city":"Oslo","zip":"0150"},"to":{"city":"Bergen","zip":"5003"}}',
);

typesFromValues([trip], { name: "trip", infer: { aliasRepeatedShapes: true } });
// { rootName: "Trip",
//   type: "{ from: From; to: From }",
//   declarations: ["type From = { city: string; zip: string };"] }
```

## Values that are not JSON

Any value works, not only what JSON can hold. A class instance is written by
its class name, and built-in objects by their type:

```ts
class Cart {
  items = new Map([["chair", 2]]);
}

typesFromValues([{ cart: new Cart(), user: { name: "Ada" } }]).type;
// { cart: Cart; user: { name: string } }
```

`Cart` is only a type where the class is in scope, so a type naming a class
belongs next to the code that has it.

## When there is no type

`type` is `undefined` when `apply` would write nothing:

- no value was given;
- part of the value is unknown, as with an empty list seen alone;
- an object is nested deeper than `maxDepth` levels, which the
  [API reference](../reference/api.md#from-values-typesfromvalues) says how to
  raise.

The [API reference](../reference/api.md#from-values-typesfromvalues) lists the
options, and [what it cannot infer](../explanation/what-it-cannot-infer.md)
covers the limits a type from values shares with one from tests.
