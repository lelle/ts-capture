# CLI reference

The `ts-capture` CLI ships with `@ts-capture/core`. Run `ts-capture --help` for
this summary. Commands below are listed in roughly the order of a typical
[observe → merge → apply](../explanation/how-it-works.md) run.

> **Commands marked ✏️ write to your source files.** Run them from a committed
> working tree — see
> [Review & apply safely](../how-to/review-and-apply-safely.md).

## `ts-capture instrument <file> [--in-place]` ✏️

Instrument a single file with type tracking. The output carries ts-capture's
runtime hooks: run it, then discard it — never commit or deploy instrumented
code.

- `--in-place` — rewrite the file instead of writing to stdout. Most users
  instrument via a bundler plugin instead, which never touches disk.

## `ts-capture merge <dir-or-files...> [--out <path>]`

Merge per-process `ts-capture-types-*.json` dumps into one `types.json`. Vitest's
`forks` pool emits one dump per spec, so merge before apply.

- `--out <path>` — output file (default: stdout).

## `ts-capture apply <types.json> [--dry-run] [--comments|--both] [--include-tests] [--force] [--report] [--telemetry] [--project <tsconfig.json>]` ✏️

Apply collected types to source files. Editing those files between collection
and apply invalidates the recorded offsets, and the output is not formatted —
see [Review & apply safely](../how-to/review-and-apply-safely.md).

- `--dry-run` — report what would change without writing.
- `--comments` — write what would be annotated as notes in the source and
  change no code: a preview in the editor. Shorthand for
  `--infer.outputMode=comments`; see [Notes](configuration.md#notes).
- `--both` — write the annotations and the notes explaining them. Shorthand for
  `--infer.outputMode=both`. The explicit `--infer.outputMode=` wins over either
  shorthand.
- `--include-tests` — apply to `*.spec.*` / `*.test.*` (default: skip them).
- `--force` — bypass the `<types.json>.applied` idempotency manifest.
- `--report` — list every observed position that was not written, with the reason.
- `--telemetry` — print entry counts to stderr: how many entries of `types.json`
  were emitted, and how many were skipped by cause. Counts raw entries, so a
  position observed in several processes is counted once per process; the
  summary below counts positions.
- `--project <tsconfig.json>` — the project to typecheck against. By default
  the nearest `tsconfig.json` above the working directory is used; name one
  when that file lists no sources (a solution-style config with
  `references`), or every check that needs a project is off.

Flags `apply` does not know are reported on stderr and the run continues
without them, naming the nearest known flag: `--comment` is not `--comments`,
and the difference is a preview against a rewrite.

Every run says how much it wrote, and whether any observation went unused:

```text title="Current"
apply: 47 annotations written in 6 files.
       12 observed positions not written (6 would add a type error, 6 with no type information) - see --report.
```

`--report` adds one entry per unused observation. An annotation that would
introduce a type error anywhere in the project is never written, test files
included, and the entry names the error:

```ts title="Input"
// src/cart.ts — observed with { lines: [...] }
export function addLine(cart, product, quantity) {
  cart.lines.push({ sku: product.sku, quantity, unitPrice: product.price });
  return cart;
}

// src/pricing.spec.ts — adds a property the observed shape does not have
const cart = addLine(createCart(), chair, 2);
cart.coupon = { kind: "percent", value: 50 };
```

```text title="Current"
Observed but not written (12)

  Would add a type error (6)
    src/cart.ts:5:25  cart
      observed  { lines: unknown[] } | { lines: { quantity: number, sku: string, unitPrice: number }[] }
      TS2339 at src/pricing.spec.ts:22: Property 'coupon' does not exist on type '{ lines: { quantity: number; sku: string; unitPrice: number; }[]; }'.

  Carries no type information (6)
    src/orders.ts:10:15  gateway
      observed  { calls: unknown[], charge(amount: unknown, reference: unknown): Promise<unknown> }

Nothing to add (16)
  16 already inferred by TypeScript
```

The groups are: _would add a type error_, _carries no type information_ (an
empty array, `unknown`, a function whose parameters were never observed),
_refers to a type this file cannot name_, and _falls outside the type already
there_. Positions where TypeScript already infers the same type, or that are
already annotated, are counted under _Nothing to add_ and not listed.

## `ts-capture coverage <tsconfig.json>`

Report the type-coverage percentage for a project.

## `ts-capture verify <types.json> --project <tsconfig.json> [--threshold=N]`

Compare runtime observations with the type TypeScript has at each observed
position. Only unannotated positions are instrumented, so the type compared
against is what TypeScript infers there: a parameter's contextual type, a
variable's initializer type, a function's inferred return type. `verify` does
not check annotations you wrote, and it rewrites nothing.

- `--project <tsconfig.json>` — the project to verify against (required).
- `--threshold=N` — exit 2 when fewer than N of the verifiable positions
  match, as a ratio (`--threshold=0.9`). Without it the exit code is 0.

Every mismatch is printed with its location, then one line of totals:

```text title="Current"
src/account.ts:12:17  balance
  declared  string
  observed  number

120 observed positions: 10 match, 1 mismatch, 104 unverifiable, 5 without a declaration.
  unverifiable: 98 declared any, 6 complex declared type
```

A position is _unverifiable_ when the comparison would be a guess: the
inferred type is `any`, `unknown` or polymorphic `this`, or a generic the
heuristic can only compare for equality. An observed `undefined` matches an
inferred `void`. _Without a declaration_ counts positions whose file is not in
the project, or that no longer line up with a declaration because the source
changed after observation.

## `ts-capture instrument-bundle <bundle.js> [--out <path>]`

Instrument an already-bundled JS artefact (for the bundle-observation flow).
The result is for observation only — never ship it.

- `--out <path>` — output file.

## `ts-capture apply-bundle <observations.json> --map <bundle.js.map> [--bundle <bundle.js>]` ✏️

Translate observations collected from a bundle back to source positions via the
source map, then apply.

- `--map <bundle.js.map>` — the bundle's source map (required).
- `--bundle <bundle.js>` — the bundle file.

## `ts-capture --help`

Show the usage summary.

> For configuration flags (`infer.*`, `apply.*`) — set in
> `ts-capture.config.json` or via `--infer.<path>=<value>` — see the
> [configuration reference](configuration.md).
