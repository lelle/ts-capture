# Configuration reference

ts-capture reads an optional **`ts-capture.config.json`**, discovered by
walking up from the working directory (`findConfigFile`). Options can be set
there or overridden ad hoc on the CLI; both resolve to the same values.

```json title="ts-capture.config.json"
{
  "infer": {
    "literal": { "string": true, "stringMaxLength": 24 },
    "patternDetection": { "isoDate": true }
  },
  "apply": {
    "skipFiles": ["src/**/*.generated.ts", "!src/generated/keep.ts"]
  }
}
```

```sh
# CLI override — only infer.* flags. Values are coerced:
#   "true"/"false" -> boolean, numeric -> number, else string.
npx ts-capture apply types.json --infer.literal.string=true --infer.literal.stringMaxLength=24
```

Every flag's default matches ts-capture's behavior with no config present —
the config layer is a no-op until you opt in. A partial config deep-merges
over the defaults, so you only specify what you change.

## Top-level keys

| Key          | Purpose                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| `infer`      | Inference behavior (the bulk of the knobs — see below).                            |
| `apply`      | `ts-capture apply` CLI behavior (currently `skipFiles`).                           |
| `common`     | Shared compiler options (`rootDir`, `tsConfig`) — resolved against the config dir. |
| `instrument` | Per-run instrumentation options (advanced).                                        |
| `applyTypes` | Per-file applier options (advanced; distinct from the `apply` CLI layer).          |

`common` / `instrument` / `applyTypes` are compiler/instrumentation plumbing;
most users only touch `infer` and `apply`.

## `infer.*`

### Merge behavior

| Flag                    | Default | What it does                                                                                                                              |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `recursiveObjectMerge`  | `true`  | Recursively merge nested object value types across observations.                                                                          |
| `crossSampleArrayMerge` | `false` | Merge `T[] \| U[]` cross-sample observations into `(T \| U)[]`.                                                                           |
| `rewriteCommonBase`     | `false` | Collapse a union of class instances to their most-specific shared ancestor. Requires runtime-side `LiteralOptions.captureClassHierarchy`. |
| `lubFallback`           | `false` | When the legacy object merge bails, fall back to anti-unification (`type-ir`); emits `unknown` for disjoint polymorphic positions.        |

### Scope & existing types

| Flag                    | Default | What it does                                                                                                                                  |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `skipInferableVarDecls` | `false` | Skip var/field annotations TypeScript would already infer from the initializer (e.g. `let count = 0`).                                        |
| `honorAsCasts`          | `true`  | Honor user-written `as Type` / `<Type>` casts on a varDecl RHS (cast wins over the observed type). Set `false` for observation-wins.          |
| `preferNamedInScope`    | `true`  | Replace a structural object type with an exact-matching in-scope `interface`/`type` name. Set `false` to always keep the structural form.     |
| `requireTypeRefInScope` | `true`  | Skip an annotation referencing a name not reachable as a type at the target file (avoids TS2304).                                             |
| `ignoreExistingTypes`   | `false` | Emit even at already-annotated positions. Produces **syntactically invalid TS** — a measurement tool, not a rewrite; the CLI warns on stderr. |

### Verification & recognition

| Flag                     | Default | What it does                                                                                                                                                                    |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cstAware`               | `true`  | Use the AST/CST-aware applier instead of the legacy string-offset applier.                                                                                                      |
| `typecheckVerify`        | `true`  | TypeChecker-in-the-loop: drop any candidate annotation that would introduce a new diagnostic in the target file or its importers. First-run cost scales with observation count. |
| `recognizeBuiltinShapes` | `true`  | Rewrite a structural shape matching a built-in (`Promise`/`Map`/`Set`/`Date`/`RegExp`/`Error`) to the named ref. Disable for projects with classes that shadow built-ins.       |

### `literal.*` — preserve literal types instead of widening

| Flag                      | Default | What it does                                                                  |
| ------------------------- | ------- | ----------------------------------------------------------------------------- |
| `literal.string`          | `false` | Preserve string-literal types (e.g. `"yes" \| "no"`) up to `stringMaxLength`. |
| `literal.stringMaxLength` | `16`    | Max length of string literals to preserve. Ignored when `string` is `false`.  |
| `literal.number`          | `false` | Preserve number-literal types (`42` instead of `number`).                     |
| `literal.boolean`         | `false` | Preserve boolean-literal types (`true`/`false` individually).                 |

```ts title="Input"
// Observed: greet always called with "hi" / "bye"; with infer.literal.string on
function greet(kind) {
  return kind;
}
```

```ts title="Expected"
function greet(kind: "hi" | "bye") {
  return kind;
}
```

With `literal.string` off (the default), the same observations widen to
`kind: string`.

> **These flags put observed data in your source.** A literal annotation is the
> value your code actually saw, copied verbatim into a `.ts` file and into
> `types.json` — on a suite running against real fixtures that can be a token
> prefix, an e-mail address or a customer name. Enable them where the values
> are genuinely enumerable domain constants (`"asc" | "desc"`, status codes).
> See [Observed values in your output](../how-to/review-and-apply-safely.md#observed-values-in-your-output).

### `patternDetection.*` — recognize string shapes

| Flag                       | Default | What it does                             |
| -------------------------- | ------- | ---------------------------------------- |
| `patternDetection.isoDate` | `false` | Detect ISO date strings and emit `Date`. |
| `patternDetection.uuid`    | `false` | Detect UUID-shaped strings.              |
| `patternDetection.url`     | `false` | Detect URL-shaped strings.               |

### Output shaping

| Flag                                     | Default | What it does                                                                                                  |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `narrowOptional.preferUndefinedOverNull` | `true`  | Prefer `T \| undefined` over `T \| null` when both are observed.                                              |
| `emitDiagnosticComments`                 | `false` | Emit `/* @ts-capture:<reason> */` markers next to coarse/fallback annotations (`generic-fn`, `shape-capped`). |
| `maxAnnotationChars`                     | `4096`  | Suppress an annotation whose final type string exceeds this cap (TS inference takes over for that position).  |

```ts title="Input"
// With infer.skipInferableVarDecls on — TS already infers number here
let count = 0;
```

```ts title="Expected"
// Left untouched: ts-capture does not add `: number` TS would infer anyway
let count = 0;
```

## `apply.*`

| Flag        | Default                             | What it does                                                                                                                                                                               |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skipFiles` | test files (`*.spec.*`, `*.test.*`) | Gitignore-style globs for files `apply` should skip. Additive on top of the built-in test default; last match wins; a leading `!` re-includes. Supports `*`, `**`, `?`, brace alternation. |

```json title="ts-capture.config.json"
{
  "apply": {
    "skipFiles": ["src/**/*.{gen,generated}.ts", "!src/generated/keep.ts"]
  }
}
```

## Environment variables

The runtime collector is configured by env, not by `ts-capture.config.json` —
it runs inside your process, before any config file is read. (The two
`@ts-capture/vite`-only rows are the exception: the plugin reads them at build
time.)

| Variable                               | Default                                 | What it does                                                                                                  |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `TS_CAPTURE_TYPES_DIR`                 | **`os.tmpdir()`**                       | Directory for the per-process `ts-capture-types-<uuid>.json` dumps. Created if missing.                       |
| `TS_CAPTURE_LITERAL_STRING`            | same as `infer.literal.string`          | Runtime equivalent of that flag.                                                                              |
| `TS_CAPTURE_LITERAL_STRING_MAX_LENGTH` | same as `infer.literal.stringMaxLength` | Runtime equivalent of that flag.                                                                              |
| `TS_CAPTURE_LITERAL_NUMBER`            | same as `infer.literal.number`          | Runtime equivalent of that flag.                                                                              |
| `TS_CAPTURE_LITERAL_BOOLEAN`           | same as `infer.literal.boolean`         | Runtime equivalent of that flag.                                                                              |
| `TS_CAPTURE_MAX_ANNOTATION_CHARS`      | same as `infer.maxAnnotationChars`      | Cap on serialized type size.                                                                                  |
| `TS_CAPTURE_CAPTURE_CLASS_HIERARCHY`   | `false`                                 | `@ts-capture/vite` only: record class hierarchies (pairs with `infer.rewriteCommonBase`).                     |
| `TS_CAPTURE_TRANSPORT_URL`             | unset                                   | `@ts-capture/vite` only, read at build time: send browser observations to this URL instead of the dev server. |

> **Every example in these docs sets `TS_CAPTURE_TYPES_DIR` explicitly.** If
> you don't, dumps land in `os.tmpdir()` and nothing cleans them up. See
> [Observed values in your output](../how-to/review-and-apply-safely.md#observed-values-in-your-output)
> for what a dump contains.
