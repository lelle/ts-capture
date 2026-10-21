# Examples

[`examples.json`](examples.json) is what the Examples page shows: what
ts-capture wrote into real code, including the results a reviewer should
change, and what a real run left alone, which How it decides shows beside the
rule that left it.

Nothing in it is written by hand. Each entry is cut from the diff of an actual
`apply` run, with the project, its commit and the ts-capture revision recorded
beside it. The file is regenerated from those runs, not edited: a change to
what ts-capture writes shows up as a diff in this file.

How the site is built from it is in
[`packages/examples-site`](../../packages/examples-site/README.md).
