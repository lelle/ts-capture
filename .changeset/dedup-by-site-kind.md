---
"@ts-capture/core": patch
---

Apply merges observations of one site instead of annotating it twice, and
verify sees what earlier files in the run were given.

**One site, one annotation.** Entries were deduplicated on the whole options
object, so two observations of the same parameter that differed only in an
incidental field — `fnRetPos`, `async` — were treated as two sites and each
emitted its own annotation, producing `x: string: string`, which does not
parse. The key is now the position plus the _site kind_: position alone is too
coarse, because a paren-less arrow's parameter and its return annotation
legitimately share an offset.

An observation of what calling a parameter returned is not an observation of
the parameter, and is no longer merged into one: `resolve` reads `Function`,
not `Function|undefined`.

**Verify sees the run so far.** The verification gate builds one
LanguageService for the whole run, and nothing told it what earlier files had
been given. Every file was checked against a project where every
previously-applied file was still unannotated, so an annotation that only
conflicts in combination with an earlier one reached disk — six such type
errors survived a run on nestjs/nest with `typecheckVerify` on.

`--dry-run` advances the same way, so the preview lists the files the real run
would write rather than the files it would attempt.
