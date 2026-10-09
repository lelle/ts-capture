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

## `ts-capture apply <types.json> [--dry-run] [--include-tests] [--force] [--report]` ✏️

Apply collected types to source files. Editing those files between collection
and apply invalidates the recorded offsets, and the output is not formatted —
see [Review & apply safely](../how-to/review-and-apply-safely.md).

- `--dry-run` — report what would change without writing.
- `--include-tests` — apply to `*.spec.*` / `*.test.*` (default: skip them).
- `--force` — bypass the `<types.json>.applied` idempotency manifest.
- `--report` — list every observed position that was not written, with the reason.

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

Compare runtime observations against the project's declared types.

- `--project <tsconfig.json>` — the project to verify against (required).
- `--threshold=N` — fail below an N% agreement threshold.

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
