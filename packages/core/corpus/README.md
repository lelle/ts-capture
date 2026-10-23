# Apply rules corpus

One folder per rule in `APPLY_RULES` (`src/contract.ts`), named after the rule.
Each holds small files that apply ends in that rule. `src/corpus.spec.ts` runs
every file the way the playground does, observing it and then applying what
was seen. The spec checks two things:

- the site named in the header ends in the folder's rule;
- every rule has at least one example.

## A rule's folder

`README.md` is the rule's title and a short paragraph about it. The other
files are examples: a header of `//` lines, a blank line, and the code. Only
the code runs, and the How it decides page shows it.

```ts
// rule: gate.erases-enum          the folder's rule
// site: mode                      the name of the site in the code, or `return type` / `this`
// title: An enum would become its values
// real: named-type                optional: ids in docs/examples/examples.json
// apply: twice                    optional: twice | moved | no-project | implicit-this
// infer: skipRedundantAnnotations=false   optional: options over the defaults
// verdict: ok                     ok | questionable; questionable stays off the page
// Why apply does this, written for the page's reader.

enum Mode { ... }
```

Each `apply:` value changes how the example is applied:

- `twice`: the second apply meets what the first one wrote.
- `moved`: a line is added above the code after the run.
- `no-project`: apply runs with no tsconfig, so there is no checker.
- `implicit-this`: `this` is observed where TypeScript says it is implicitly `any`.

## Answer keys

Each `<example>.after.ts` is generated. It holds the file as apply leaves it,
then one line per site: the outcome, the rule, the observed type, and the
detail. A change in behaviour shows up as a diff there. Update the keys with:

```sh
pnpm --filter @ts-capture/core exec vitest run src/corpus.spec.ts -u
```

Read that diff before committing it.

To list the cases still open: `grep -rl "verdict: questionable" packages/core/corpus`.
