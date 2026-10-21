# What it does to your project

ts-capture is not a passive observer the way a linter or a type-checker is.
Before you point it at real code, know the four things it does there.

## It rewrites your source files

`apply`, `instrument --in-place` and `core/register` edit code on disk;
`register` and the Vite dev server's `apply: true` do it with no preview at
all. Run from a committed working tree, so every change is a `git diff` you can
read and undo. → [Review & apply safely](../how-to/review-and-apply-safely.md)

## It runs your getters

Describing a value means reading every property of it, so getters and `Proxy`
traps run during an instrumented run, more often than your own code would run
them, and an accessor that throws is swallowed. Treat an instrumented run as a
diagnostic run, never as a production one. →
[Observation reads your values](how-it-works.md#observation-reads-your-values--including-getters)

## It writes what it saw to disk

Every process writes a dump of what it observed, and with
`TS_CAPTURE_TYPES_DIR` unset those dumps go to `os.tmpdir()`, where nothing
deletes them. A dump maps your code: paths, parameter names, the keys of your
objects, and with literal types on, the values. Point the directory into the
project, keep it out of git, delete it when done. →
[Observed values in your output](../how-to/review-and-apply-safely.md#observed-values-in-your-output) ·
[`TS_CAPTURE_TYPES_DIR`](../reference/configuration.md#environment-variables)

## In a browser, it sends what it saw

Browser observations are posted to the Vite dev server, which does not ask who
is posting, or to the URL `transports` names. Send them only to a collector you
control, and never ship an instrumented build. →
[What the dev server exposes](../../packages/vite/README.md#what-the-dev-server-exposes)
