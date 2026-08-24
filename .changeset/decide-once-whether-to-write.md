---
"@ts-capture/core": patch
---

The rules that decide whether an annotation is worth writing are asked once, for
both appliers.

They were asked in four places — once in the offset applier, once per site kind
in the CST one — and the copies had drifted. The parameter branch never asked
whether the checker's type was a polymorphic `this`, so a callback parameter
TypeScript types as `this` was annotated with the concrete class the run
happened to see, which costs every subclass its own type. The other three
branches refused it.

A contradiction now settles its site in one place too, and the note it produces
is recorded whether or not it can go above the line: whether a note ends up
leading or beside the code is known only after the whole file is read, and only
the leading form cares what the line starts inside. A conflict note on a crowded
line inside a template was being discarded for a reason that did not apply to
where it would actually be written.

Also removed: a suppression rule for all-`unknown` arrow types that had been
dead since the broader "describes no payload" rule replaced it. Every string it
matched, the newer rule matches too, and more besides — deleting it changed no
test.
