---
"@ts-capture/core": minor
---

Apply can show what it would write instead of writing it.

`infer.outputMode` takes `annotations` (the default), `comments`, or `both`.
In `comments` the source keeps its shape and each site gets a note saying what
an annotation would have been; in `both` the annotation lands and the note
records the evidence beside it:

```ts
// @ts-capture[proposal]: `pattern` would be `string`
// @ts-capture:   observed once; TypeScript infers `number | undefined`
const pattern = this.getPattern(packet);
```

A preview is only written for an annotation that would really land. Candidates
are buffered and settled after the verification pass, so a site `tsc` would have
rejected produces no note promising something that was never going to happen.
The notes are owned and rewritten by apply exactly as the conflict notes are, and
they are not written into a template literal or JSX text for the same reason.

**In `both` mode the note drops the suggestion.** The annotation is on the line;
repeating it as `would write` says something that is no longer true, so what
remains is the part the annotation cannot show — how many times the value was
observed, and what TypeScript infers there.

**Every note reports the site it is about.** The checker's view is held in one
place while a site is decided, and a value left from the previous entry names a
different position: a `this` preview reported the type of a binding in another
function. Each entry now starts from nothing, so a note that cannot say what
TypeScript infers omits the line rather than borrowing one.
