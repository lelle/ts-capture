# Apply rules corpus

One folder per rule in `APPLY_RULES` (`src/contract.ts`), named after the rule.
Each holds small files that apply ends in that rule. `src/corpus.spec.ts` runs
every file the way the playground does, observing it and then applying what
was seen. The spec checks two things:

- the site named in the header ends in the folder's rule;
- every rule has at least one example.

## Header

```ts
// rule: gate.discards-union-arm   the folder's rule
// site: fromNull                  the name the report gives the site; `*` for any
// apply: twice                    optional: twice | moved | no-project
// verdict: questionable           ok | questionable
// Why apply does this, and what makes it questionable.
```

Each `apply:` value changes how the example is applied:

- `twice`: the second apply meets what the first one wrote.
- `moved`: a line is added above the code after the run.
- `no-project`: apply runs with no tsconfig, so there is no checker.

## Answer keys

Each `<example>.after.ts` is generated. It holds the file as apply leaves it,
then one line per site: the outcome, the rule, the observed type, and the
detail. A change in behaviour shows up as a diff there. Update the keys with:

```sh
pnpm --filter @ts-capture/core exec vitest run src/corpus.spec.ts -u
```

Read that diff before committing it.

To list the cases still open: `grep -rl "verdict: questionable" packages/core/corpus`.
