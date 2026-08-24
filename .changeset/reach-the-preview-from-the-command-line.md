---
"@ts-capture/core": minor
---

`apply` takes `--comments` and `--both`, and writes a manifest only when it
wrote something.

**The flags.** `--comments` writes what would be annotated as notes and changes
no code; `--both` writes the annotations and the notes explaining them. Both are
shorthand for `--infer.outputMode`, and the explicit form wins, so a flag never
becomes a second source of truth.

**Unrecognised flags now say so.** They still run — a script sending a flag a
newer version understands should not stop — but `apply` rewrites source files,
and the flags that hold it back are exactly the ones a typo turns off.
`--comment` is not `--comments`, and the difference between them is a preview
against a rewrite. Anything `apply` does not act on is named on stderr, with the
nearest flag it knows when there is one.

**The manifest records an apply, so a preview no longer writes one.** The
manifest is what a second run reads to know a `types.json` was already applied.
A preview writes the file and annotates nothing, which is neither a dry run nor
an apply, and the manifest had no third case — it claimed the input was applied
and closed the one workflow the mode exists for: read the proposals, then take
them. The same holds for a real apply whose every candidate was suppressed.
Nothing was written, so there is nothing for a second pass to short-circuit, and
saying otherwise is the same untruth.
