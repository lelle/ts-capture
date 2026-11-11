# API reference

`@ts-capture/core` exports the steps the CLI and the plugins are built from.
Use them when the CLI does not fit: a custom runner, a build step, an editor
integration. Everything here is from the package root.

From a CommonJS project, set `"module": "nodenext"` in `tsconfig.json`. Under
`node16`, TypeScript reads the package's declarations as ESM and reports
TS1479 on the import, though `require` itself works.

```ts
import {
  annotate,
  annotateProject,
  instrumentSource,
  typeCoverage,
  typesFromValues,
} from "@ts-capture/core";
```

## From values: `typesFromValues`

`typesFromValues` gives the type `apply` would write for a parameter called
once with each value. Nothing is instrumented and no file is read, so it works
on any value at hand: parsed JSON, a fixture, an object in a debugger.

```ts
import { typesFromValues } from "@ts-capture/core";

const orders = [
  { id: 7, customer: { name: "Ada" }, lines: [{ sku: "A1", qty: 2 }] },
  {
    id: 8,
    customer: { name: "Bo" },
    lines: [{ sku: "B2", qty: 1, note: "gift" }],
  },
];

typesFromValues(orders).type;
// { customer: { name: string }; id: number; lines: { note?: string; qty: number; sku: string }[] }
```

Each value counts as one call, so a field only some values have is optional.
The options are the ones the rest of ts-capture takes: `infer` as in
[`ts-capture.config.json`](configuration.md), and `literalOptions` as given to
the Vite plugin. `infer.literal` also decides which literals are observed,
unless `literalOptions` says otherwise. With `infer.aliasRepeatedShapes`, a
shape the values repeat is declared once; `name` is the parameter name apply
would see, which a declared shape may be named after. `rootName` is `name` as a
type name (`_order` gives `Order`), and no declared shape takes it, so
`type ${rootName} = ${type}` can sit beside the declarations.

```ts
const trip = JSON.parse(
  '{"from":{"city":"Oslo","zip":"0150"},"to":{"city":"Bergen","zip":"5003"}}',
);

typesFromValues([trip], { name: "trip", infer: { aliasRepeatedShapes: true } });
// { rootName: "Trip",
//   type: "{ from: From; to: From }",
//   declarations: ["type From = { city: string; zip: string };"] }
```

`type` is `undefined` when apply would write nothing: no value was given, or
part of the type is unknown, as with an empty list seen alone or an object
nested deeper than `maxDepth` levels. `maxDepth` is 5 unless given, as deep as
observation reads, and `{ maxDepth: 8 }` reads deeper JSON such as a GraphQL
response. It is also exported from `@ts-capture/core/browser`.

## Apply: `annotateProject` and `annotate`

`annotateProject` writes the observed types into every file they name.
`types` is a merged `types.json`; `readFile` returns a file's text, or
`undefined` for a file it cannot read.

```ts
import { readFileSync } from "node:fs";
import { annotateProject } from "@ts-capture/core";

const types = JSON.parse(readFileSync("types.json", "utf-8"));
const { files } = annotateProject({
  types,
  readFile: (path) => readFileSync(path, "utf-8"),
});

for (const [path, result] of files) {
  // result.text is the annotated source; nothing is written to disk.
  console.log(path, result.skips.length, "positions not written");
}
```

Each result has the annotated `text`, the `skips` (positions not written, with
the reason, as in `apply --report`) and the `telemetry` counts.

`annotate(text, entries, options)` does the same for one file's text, with the
entries for that file.

### How much it may ask TypeScript: `oracle`

| `oracle`                       | What it adds                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `{ kind: "none" }` (default)   | Syntax only.                                                                                                            |
| `{ kind: "program", program }` | A `ts.Program` holding the file: skips what TypeScript already infers, and names out of scope.                          |
| `{ kind: "project", project }` | Type-checks each candidate and drops one that would add an error, as the CLI does. Files are annotated in import order. |

`project` comes from `createProjectVerificationContext(fileNames, compilerOptions, rootDir)`.

`infer` takes the [`infer.*` options](configuration.md#infer), merged over the
defaults; `ignoreFiles` takes regular expressions for files to leave alone.

`applyTypesToFile` and `applyTypesToFiles` are earlier names for the same
applier, returning only the text.

## Instrument: `instrumentSource`

```ts
const instrumented = instrumentSource(source, "src/cart.ts");
```

Returns the source with the observation calls added. The calls go to a global
`__tscptr__`, which the runtime installs: `@ts-capture/core/register` or
`@ts-capture/core/preload` in Node, or the bundler plugins' runtime. The
[packages reference](packages.md) says which one fits which setup.

## Coverage: `typeCoverage`

`typeCoverage(program)` returns `{ knownTypes, totalTypes, percentage }`: how
many of the program's identifiers have a type other than `any`, the number
`ts-capture coverage` prints.
